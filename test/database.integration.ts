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
async function create(publicWrite = true) {
  await db.query("reset role");
  const id = crypto.randomUUID();
  ids.push(id);
  await db.query(
    "insert into dv_documents(id,config,data,public_read,public_write) values($1,$2,$3,$4,$4)",
    [id, config, data, publicWrite],
  );
  await db.query("set role anon");
  return id;
}
async function commit(
  id: string,
  ops: unknown[],
  request = crypto.randomUUID(),
) {
  return (
    await db.query("select dv_apply($1,$2,$3) result", [
      id,
      request,
      JSON.stringify(ops),
    ])
  ).rows[0].result;
}
const set = (field: string, before: string, value: string) => ({
  kind: "set",
  type: "task",
  id: "t",
  field,
  before,
  value,
});
test("database merges disjoint writes and rejects stale same-field writes", async () => {
  const id = await create();
  await commit(id, [set("name", "Task", "Changed")]);
  const b = await commit(id, [set("status", "Open", "Done")]);
  assert.equal(b.snapshot.data.task[0].name, "Changed");
  assert.equal(b.snapshot.revision, 2);
  const conflict = await commit(id, [set("name", "Task", "Stale")]);
  assert.ok(conflict.conflict);
  assert.equal(conflict.snapshot.data.task[0].name, "Changed");
});
test("database retry receipt prevents duplicate writes", async () => {
  const id = await create(),
    req = crypto.randomUUID();
  const a = await commit(id, [set("name", "Task", "Saved")], req);
  const b = await commit(id, [set("name", "Task", "Saved")], req);
  assert.equal(a.snapshot.revision, b.snapshot.revision);
});
test("database batch validation is atomic", async () => {
  const id = await create();
  await assert.rejects(() =>
    commit(id, [
      set("name", "Task", "Changed"),
      set("status", "Open", "invalid"),
    ]),
  );
  const rows = (
    await db.query("select data,revision from dv_documents where id=$1", [id])
  ).rows;
  assert.equal(rows[0].revision, "0");
  assert.equal(rows[0].data.task[0].name, "Task");
});
test("database deletion removes relationship IDs", async () => {
  const id = await create();
  const r = await commit(id, [
    { kind: "delete", type: "person", id: "p", before: data.person[0] },
  ]);
  assert.deepEqual(r.snapshot.data.task[0].leads, []);
  assert.deepEqual(r.snapshot.data.person, []);
});
test("private documents reject anonymous reads and writes", async () => {
  const id = await create(false);
  assert.equal(
    (await db.query("select * from dv_documents where id=$1", [id])).rows
      .length,
    0,
  );
  await assert.rejects(
    () => commit(id, [set("name", "Task", "Denied")]),
    /Not allowed/,
  );
});
test("public clients cannot bypass RPC with direct table update", async () => {
  const id = await create();
  await assert.rejects(
    () => db.query("update dv_documents set revision=100 where id=$1", [id]),
    /permission denied/,
  );
});
test("invalid relationships cannot be introduced", async () => {
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
test("long text accepts empty and multi-line values", async () => {
  await db.query("reset role");
  const id = crypto.randomUUID();
  ids.push(id);
  const long = {
    schema: { note: { name: "text", body: "longtext" } },
    collection: "note",
  };
  await db.query(
    "insert into dv_documents(id,config,data,public_read,public_write) values($1,$2,$3,true,true)",
    [id, long, { note: [{ id: "n", name: "Note", body: "" }] }],
  );
  await db.query("set role anon");
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
test("writes stamp the record; a delete ignores the stamp it was sent", async () => {
  const id = await create();
  const a = await commit(id, [set("name", "Task", "Changed")]);
  assert.match(a.snapshot.data.task[0].modified, /^\d{4}-\d\d-\d\dT[\d:.]+Z$/);
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
});
test("long text may exceed the single-line limit", async () => {
  await db.query("reset role");
  const id = crypto.randomUUID();
  ids.push(id);
  const long = {
    schema: { note: { name: "text", body: "longtext" } },
    collection: "note",
  };
  await db.query(
    "insert into dv_documents(id,config,data,public_read,public_write) values($1,$2,$3,true,true)",
    [id, long, { note: [{ id: "n", name: "Note", body: "" }] }],
  );
  await db.query("set role anon");
  const body = "x".repeat(20000);
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
