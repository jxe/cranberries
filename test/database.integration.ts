import { test, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { config, data } from "./fixtures";
const connectionString = process.env.DV_TEST_DATABASE_URL;
if (!connectionString)
  throw Error(
    "Set DV_TEST_DATABASE_URL to an isolated database with the library migration installed.",
  );
const db = new pg.Client({ connectionString });
await db.connect();
const ids: string[] = [];
after(async () => {
  await db.query("reset role");
  for (const id of ids)
    await db.query("delete from dv_documents where id=$1", [id]);
  await db.end();
});
// Each test runs against both storage adaptors.
let adaptor = "triples";
async function provision(
  docConfig: unknown,
  docData: unknown,
  publicWrite = true,
) {
  await db.query("reset role");
  const id = crypto.randomUUID();
  ids.push(id);
  await db.query("select dv_provision($1,$2,$3,$4,$4,$5)", [
    id,
    JSON.stringify(docConfig),
    JSON.stringify(docData),
    publicWrite,
    adaptor,
  ]);
  await db.query("set role anon");
  return id;
}
const create = (publicWrite = true) => provision(config, data, publicWrite);
const read = async (id: string) =>
  (await db.query("select dv_read($1) result", [id])).rows[0].result;
async function commit(
  id: string,
  ops: unknown[],
  request = crypto.randomUUID(),
) {
  const result = (
    await db.query("select dv_apply($1,$2,$3) result", [
      id,
      request,
      JSON.stringify(ops),
    ])
  ).rows[0].result;
  // A committed write answers with its change; read back what it left.
  return result.snapshot ? result : { ...result, snapshot: await read(id) };
}
function both(name: string, fn: () => Promise<void>) {
  for (const kind of ["triples", "blob"])
    test(`${name} (${kind})`, async () => {
      adaptor = kind;
      await fn();
    });
}
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
  assert.equal(
    (await db.query("select * from dv_documents where id=$1", [id])).rows
      .length,
    0,
  );
  await assert.rejects(() => read(id), /Document unavailable/);
  await assert.rejects(
    () => commit(id, [set("name", "Task", "Denied")]),
    /Not allowed/,
  );
});
both("public clients cannot bypass RPC with direct table update", async () => {
  const id = await create();
  await assert.rejects(
    () => db.query("update dv_documents set revision=100 where id=$1", [id]),
    /permission denied/,
  );
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
  const result = (
    await db.query("select dv_apply($1,$2,$3,$4) result", [
      id,
      crypto.randomUUID(),
      JSON.stringify(ops),
      "p",
    ])
  ).rows[0].result;
  assert.equal(result.change.revision, 1);
  const log = (
    await db.query(
      "select revision,at,by,operations from dv_changes where document_id=$1",
      [id],
    )
  ).rows;
  assert.equal(log.length, 1);
  assert.equal(log[0].by, "p");
  assert.equal(log[0].at, result.change.at);
  assert.deepEqual(log[0].operations, ops);
  assert.equal((await read(id)).data.task[0].modified, result.change.at);
  await assert.rejects(
    () => db.query("delete from dv_changes where document_id=$1", [id]),
    /permission denied/,
  );
});
both(
  "a config change needs no data change when the new field has a default",
  async () => {
    const id = await create();
    const next = structuredClone(config) as any;
    next.collections.task.fields.note = { type: "longtext", default: "None" };
    await db.query("reset role");
    await db.query("select dv_configure($1,$2)", [id, JSON.stringify(next)]);
    assert.equal((await read(id)).data.task[0].note, "None");
    next.collections.task.fields.status.options = [{ name: "Done" }];
    await assert.rejects(
      () => db.query("select dv_configure($1,$2)", [id, JSON.stringify(next)]),
      /Invalid choice/,
    );
    await db.query("set role anon");
    await assert.rejects(
      () =>
        db.query("select dv_configure($1,$2)", [id, JSON.stringify(config)]),
      /permission denied/,
    );
  },
);
test("a document moves between adaptors with its records and order intact", async () => {
  adaptor = "blob";
  const id = await create();
  await commit(id, [set("name", "Task", "Kept")]);
  const before = await read(id);
  await db.query("reset role");
  await db.query("select dv_move($1,'triples')", [id]);
  assert.equal(
    (await db.query("select data from dv_documents where id=$1", [id])).rows[0]
      .data.task,
    undefined,
  );
  await db.query("set role anon");
  assert.deepEqual(await read(id), before);
  const r = await commit(id, [set("name", "Kept", "Moved")]);
  assert.equal(r.snapshot.data.task[0].name, "Moved");
  assert.equal(r.snapshot.revision, 2);
});
test("a document from before adaptors keeps working, with its config rewritten", async () => {
  await db.query("reset role");
  const doc = (
    await db.query("select config,adaptor from dv_documents where id='legacy'")
  ).rows[0];
  assert.equal(doc.adaptor, "blob");
  assert.deepEqual(doc.config, {
    title: "Legacy",
    collections: {
      person: {
        label: "lead",
        fixed: true,
        fields: { name: { type: "text" } },
      },
      task: {
        fields: {
          name: { type: "text" },
          leads: { type: "many", of: "person", label: "lead" },
          status: {
            type: "choice",
            bullet: true,
            options: [{ name: "Open", color: "#111" }, { name: "Done" }],
          },
          note: { type: "longtext" },
        },
      },
    },
    main: "task",
    line: ["name"],
    views: [{ label: "All" }],
  });
  await db.query("set role anon");
  const r = await commit("legacy", [
    { ...set("status", "Open", "Done"), id: "t" },
  ]);
  assert.equal(r.snapshot.data.task[0].status, "Done");
});
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
    assert.equal((await read(id)).title, "Renamed");
    await assert.rejects(
      () => commit(id, [title("Renamed", " ")]),
      /Invalid title/,
    );
  },
);
