import { test, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { createServer, pgDatabase } from "../src/server";
import type { Config, Data, Operation } from "../src/model";
import { config, data } from "./fixtures";
const connectionString = process.env.DV_TEST_DATABASE_URL;
if (!connectionString)
  throw Error(
    "Set DV_TEST_DATABASE_URL to an isolated database with the library migration installed.",
  );
const pool = new pg.Pool({ connectionString, max: 4 });
const db = new pg.Client({ connectionString });
await db.connect();
const server = createServer({ database: pgDatabase(pool) });
const ids: string[] = [];
after(async () => {
  for (const id of ids)
    await db.query("delete from dv_documents where id=$1", [id]);
  await db.end();
  await pool.end();
});
async function provision(
  docConfig: unknown,
  docData: unknown,
  publicWrite = true,
) {
  const id = crypto.randomUUID();
  ids.push(id);
  await server.provision({
    documentId: id,
    config: docConfig as Config,
    data: docData as Data,
    publicRead: publicWrite,
    publicWrite,
  });
  return id;
}
const create = (publicWrite = true) => provision(config, data, publicWrite);
const read = (id: string) => server.read(id) as Promise<any>;
async function commit(
  id: string,
  ops: unknown[],
  request = crypto.randomUUID(),
) {
  const result: any = await server.apply(id, request, ops as Operation[]);
  // A committed write answers with its change; read back what it left.
  return result.snapshot ? result : { ...result, snapshot: await read(id) };
}
const both = (name: string, fn: () => Promise<void>) => test(name, fn);
const long = {
  collections: {
    note: { fields: { name: { type: "text" }, body: { type: "longtext" } } },
  },
  main: "note",
};
const set = (field: string, before: string, value: string) => ({
  kind: "set",
  type: "task",
  id: "t",
  field,
  before,
  value,
});
both(
  "database merges disjoint writes and rejects stale same-field writes",
  async () => {
    const id = await create();
    await commit(id, [set("name", "Task", "Changed")]);
    const b = await commit(id, [set("status", "Open", "Done")]);
    assert.equal(b.snapshot.data.task[0].name, "Changed");
    assert.equal(b.snapshot.revision, 2);
    const conflict = await commit(id, [set("name", "Task", "Stale")]);
    assert.ok(conflict.conflict);
    assert.equal(conflict.snapshot.data.task[0].name, "Changed");
  },
);
both("database retry receipt prevents duplicate writes", async () => {
  const id = await create(),
    req = crypto.randomUUID();
  const a = await commit(id, [set("name", "Task", "Saved")], req);
  const b = await commit(id, [set("name", "Task", "Saved")], req);
  assert.equal(a.snapshot.revision, b.snapshot.revision);
});
both("database batch validation is atomic", async () => {
  const id = await create();
  await assert.rejects(() =>
    commit(id, [
      set("name", "Task", "Changed"),
      set("status", "Open", "invalid"),
    ]),
  );
  const now = await read(id);
  assert.equal(now.revision, 0);
  assert.equal(now.data.task[0].name, "Task");
});
both("database deletion removes relationship IDs", async () => {
  const id = await create();
  const r = await commit(id, [
    { kind: "delete", type: "person", id: "p", before: data.person[0] },
  ]);
  assert.deepEqual(r.snapshot.data.task[0].leads, []);
  assert.deepEqual(r.snapshot.data.person, []);
});
both("private documents reject anonymous reads and writes", async () => {
  const id = await create(false);
  await assert.rejects(() => read(id), /Document unavailable/);
  assert.equal((await server.read(id, { trusted: true })).revision, 0);
  await assert.rejects(
    () => commit(id, [set("name", "Task", "Denied")]),
    /Not allowed/,
  );
});
both("browsers can read the change log and nothing else", async () => {
  const id = await create();
  await commit(id, [set("name", "Task", "Changed")]);
  await db.query("set role anon");
  try {
    assert.equal(
      (await db.query("select 1 from dv_changes where document_id=$1", [id]))
        .rows.length,
      1,
    );
    for (const sql of [
      "update dv_documents set revision=100",
      "select * from dv_facts",
      "delete from dv_changes",
    ])
      await assert.rejects(() => db.query(sql), /permission denied/);
  } finally {
    await db.query("reset role");
  }
});
both("invalid relationships cannot be introduced", async () => {
  const id = await create();
  await assert.rejects(
    () =>
      commit(id, [
        {
          kind: "set",
          type: "task",
          id: "t",
          field: "leads",
          before: ["p"],
          value: ["missing"],
        },
      ]),
    /Missing related entity/,
  );
});
both("long text accepts empty and multi-line values", async () => {
  const id = await provision(long, {
    note: [{ id: "n", name: "Note", body: "" }],
  });
  const result = await commit(id, [
    {
      kind: "set",
      type: "note",
      id: "n",
      field: "body",
      before: "",
      value: "a\nb",
    },
    {
      kind: "set",
      type: "note",
      id: "n",
      field: "body",
      before: "a\nb",
      value: "",
    },
  ]);
  assert.equal(result.conflict, undefined);
  assert.equal(result.snapshot.data.note[0].body, "");
});
both(
  "writes stamp the record; a delete ignores the stamp it was sent",
  async () => {
    const id = await create();
    const a = await commit(id, [set("name", "Task", "Changed")]);
    assert.match(
      a.snapshot.data.task[0].modified,
      /^\d{4}-\d\d-\d\dT[\d:.]+Z$/,
    );
    assert.equal(a.snapshot.data.person[0].modified, undefined);
    const made = await commit(id, [
      {
        kind: "create",
        type: "task",
        id: "n",
        value: {
          id: "n",
          name: "New",
          leads: [],
          status: "Open",
          modified: "1999",
        },
      },
    ]);
    assert.notEqual(made.snapshot.data.task[1].modified, "1999");
    const gone = await commit(id, [
      {
        kind: "delete",
        type: "task",
        id: "t",
        before: { ...data.task[0], name: "Changed" },
      },
    ]);
    assert.equal(gone.conflict, undefined);
    assert.deepEqual(
      gone.snapshot.data.task.map((r: { id: string }) => r.id),
      ["n"],
    );
  },
);
both("long text may exceed the single-line limit", async () => {
  const id = await provision(long, {
    note: [{ id: "n", name: "Note", body: "" }],
  });
  // Varied, so it is long even where the database compresses it.
  const body = Array.from({ length: 2000 }, () =>
    crypto.randomUUID().slice(0, 10),
  ).join("");
  const ok = await commit(id, [
    {
      kind: "set",
      type: "note",
      id: "n",
      field: "body",
      before: "",
      value: body,
    },
  ]);
  assert.equal(ok.snapshot.data.note[0].body.length, 20000);
  await assert.rejects(() =>
    commit(id, [
      {
        kind: "set",
        type: "note",
        id: "n",
        field: "name",
        before: "Note",
        value: body,
      },
    ]),
  );
});
both("a conflict undoes the earlier operations of its batch", async () => {
  const id = await create();
  const r = await commit(id, [
    set("status", "Open", "Done"),
    set("name", "Stale", "Changed"),
  ]);
  assert.ok(r.conflict);
  assert.equal(r.snapshot.revision, 0);
  assert.equal(r.snapshot.data.task[0].status, "Open");
  assert.equal((await read(id)).data.task[0].status, "Open");
});
both(
  "members are added and removed one at a time, without a before value",
  async () => {
    const id = await create();
    const person = (pid: string) => ({
      kind: "create",
      type: "person",
      id: pid,
      value: { id: pid, name: pid },
    });
    const link = (kind: string, value: string) => ({
      kind,
      type: "task",
      id: "t",
      field: "leads",
      value,
    });
    await commit(id, [person("q"), person("r")]);
    await commit(id, [link("link", "q")]);
    await commit(id, [link("link", "r"), link("link", "q")]);
    const r = await commit(id, [link("unlink", "p"), link("unlink", "p")]);
    assert.deepEqual(r.snapshot.data.task[0].leads, ["q", "r"]);
    await assert.rejects(
      () => commit(id, [link("link", "missing")]),
      /Missing related entity/,
    );
  },
);
both("every write is logged with its operations, time and writer", async () => {
  const id = await create();
  const ops = [set("name", "Task", "Changed")];
  const result = await server.apply(
    id,
    crypto.randomUUID(),
    ops as Operation[],
    "p",
  );
  assert.equal(result.change!.revision, 1);
  const log = (
    await db.query(
      "select revision,at,by,operations from dv_changes where document_id=$1",
      [id],
    )
  ).rows;
  assert.equal(log.length, 1);
  assert.equal(log[0].by, "p");
  assert.equal(log[0].at, result.change!.at);
  assert.deepEqual(log[0].operations, ops);
  assert.equal((await read(id)).data.task[0].modified, result.change!.at);
});
both(
  "a config change needs no data change when the new field has a default",
  async () => {
    const id = await create();
    const next = structuredClone(config) as any;
    next.collections.task.fields.note = { type: "longtext", default: "None" };
    await server.configure(id, next);
    assert.equal((await read(id)).data.task[0].note, "None");
    next.collections.task.fields.status.options = [{ name: "Done" }];
    await assert.rejects(() => server.configure(id, next), /Invalid choice/);
  },
);
both(
  "the title is saved, checked against what the writer saw, and undone with its batch",
  async () => {
    const id = await create();
    assert.equal((await read(id)).title, "Example");
    const title = (before: string, value: string) => ({
      kind: "title",
      before,
      value,
    });
    const a = await commit(id, [title("Example", "Renamed")]);
    assert.equal(a.snapshot.title, "Renamed");
    assert.ok((await commit(id, [title("Example", "Stale")])).conflict);
    const b = await commit(id, [
      title("Renamed", "Again"),
      set("name", "Wrong", "Changed"),
    ]);
    assert.ok(b.conflict);
    assert.equal(b.snapshot.title, "Renamed");
    await assert.rejects(
      () => commit(id, [title("Renamed", " ")]),
      /Invalid title/,
    );
  },
);
both("two writes at once to one document both land, in order", async () => {
  const id = await create();
  const [a, b] = await Promise.all([
    commit(id, [set("name", "Task", "Changed")]),
    commit(id, [set("status", "Open", "Done")]),
  ]);
  assert.equal(a.conflict ?? b.conflict, undefined);
  const now = await read(id);
  assert.equal(now.revision, 2);
  assert.equal(now.data.task[0].name, "Changed");
  assert.equal(now.data.task[0].status, "Done");
});
both("the HTTP handler answers reads, writes and mistakes", async () => {
  const id = await create();
  assert.equal(
    ((await server.handle({ method: "GET", document: id })).body as any)
      .revision,
    0,
  );
  const ok = await server.handle({
    method: "POST",
    document: id,
    body: {
      requestId: crypto.randomUUID(),
      operations: [set("name", "Task", "Over HTTP")],
    },
  });
  assert.equal((ok.body as any).change.revision, 1);
  const bad = await server.handle({
    method: "POST",
    document: id,
    body: {
      requestId: crypto.randomUUID(),
      operations: [set("status", "Open", "nope")],
    },
  });
  assert.equal(bad.status, 400);
  assert.equal(
    (await server.handle({ method: "GET", document: "missing" })).status,
    404,
  );
});
