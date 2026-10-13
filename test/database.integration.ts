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
// Writes need someone signed in; most tests are not about who.
const someone = { person: "p" };
const create = (publicWrite = true) => provision(config, data, publicWrite);
const read = (id: string) => server.read(id) as Promise<any>;
async function commit(
  id: string,
  ops: unknown[],
  request = crypto.randomUUID(),
) {
  const result: any = await server.apply(
    id,
    request,
    ops as Operation[],
    null,
    someone,
  );
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
    // The writer is who is signed in, whatever name is sent along.
    "someone-else",
    { person: "p" },
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
  const id = await provision(team, teamData);
  const session = await signIn(id, "p");
  assert.equal(
    ((await server.handle({ method: "GET", document: id })).body as any)
      .revision,
    0,
  );
  const ok = await server.handle({
    method: "POST",
    document: id,
    session,
    body: {
      requestId: crypto.randomUUID(),
      operations: [set("name", "Task", "Over HTTP")],
    },
  });
  assert.equal((ok.body as any).change.revision, 1);
  const bad = await server.handle({
    method: "POST",
    document: id,
    session,
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

// Signing in. `team` has an admin and a collection only its owners may change.
const team = {
  ...config,
  admin: "boss",
  collections: {
    person: { ...config.collections.person, kind: "person" },
    task: { ...config.collections.task, owners: "leads" },
  },
};
const teamData = {
  person: ["boss", "p", "q"].map((id) => ({ id, name: id })),
  task: [
    { id: "t", name: "Task", leads: ["p"], status: "Open" },
    { id: "free", name: "Free", leads: [], status: "Open" },
  ],
};
const post = async (
  document: string,
  body: object,
  session?: string,
): Promise<any> => {
  const r = await server.handle({ method: "POST", document, session, body });
  return { status: r.status, ...(r.body as object) };
};
const write = (id: string, session: string | undefined, ...ops: unknown[]) =>
  post(id, { requestId: crypto.randomUUID(), operations: ops }, session);
// A session for a person, by way of a link as the admin script makes one.
async function signIn(id: string, person: string) {
  const link = await server.auth.createLink(id, person, { trusted: true });
  return (await post(id, { action: "exchange", token: link.token }))
    .session as string;
}
const on = (id: string, field: string, before: string, value: string) => ({
  ...set(field, before, value),
  id,
});
both(
  "a sign-in link gives a session, again and again, until revoked",
  async () => {
    const id = await provision(team, teamData);
    // The script's link is for the admin named in the config.
    const first = await server.auth.createLink(id, undefined, {
      trusted: true,
    });
    assert.equal(first.person, "boss");
    const boss = await post(id, { action: "exchange", token: first.token });
    assert.deepEqual(
      [boss.status, boss.person, boss.admin],
      [200, "boss", true],
    );
    // Only hashes are kept: the token and session appear nowhere in the tables.
    const kept = JSON.stringify(
      (
        await db.query(
          "select (select json_agg(l) from dv_links l) links, (select json_agg(s) from dv_sessions s) sessions",
        )
      ).rows,
    );
    assert.ok(!kept.includes(first.token) && !kept.includes(boss.session));
    // The admin makes a link for someone else; it works more than once.
    const made = await post(
      id,
      { action: "link-create", person: "q" },
      boss.session,
    );
    assert.equal(made.status, 200);
    const a = await post(id, { action: "exchange", token: made.token });
    const b = await post(id, { action: "exchange", token: made.token });
    assert.deepEqual([a.person, a.admin, b.person], ["q", false, "q"]);
    assert.notEqual(a.session, b.session);
    assert.deepEqual(await post(id, { action: "whoami" }, a.session), {
      status: 200,
      person: "q",
      admin: false,
    });
    assert.equal(
      (await write(id, a.session, on("free", "name", "Free", "Q's"))).status,
      200,
    );
    // Only the admin lists, makes and revokes links.
    for (const session of [a.session, undefined, "made-up"]) {
      assert.ok((await post(id, { action: "links" }, session)).status >= 401);
      assert.ok(
        (await post(id, { action: "link-create", person: "p" }, session))
          .status >= 401,
      );
      assert.ok(
        (await post(id, { action: "link-revoke", id: made.id }, session))
          .status >= 401,
      );
    }
    assert.equal(
      (
        await post(
          id,
          { action: "link-create", person: "nobody" },
          boss.session,
        )
      ).status,
      400,
    );
    const listed = (await post(id, { action: "links" }, boss.session)).links;
    assert.deepEqual(listed.map((l: any) => l.person).sort(), ["boss", "q"]);
    assert.ok(
      listed.every(
        (l: any) => l.last_used_at && !l.revoked_at && !l.token_hash,
      ),
    );
    // Revoking ends the link and every session it gave.
    assert.equal(
      (await post(id, { action: "link-revoke", id: made.id }, boss.session))
        .status,
      200,
    );
    assert.equal(
      (await post(id, { action: "exchange", token: made.token })).status,
      401,
    );
    assert.equal(
      (await post(id, { action: "whoami" }, a.session)).person,
      null,
    );
    assert.equal(
      (await write(id, b.session, on("free", "name", "Q's", "Again"))).status,
      401,
    );
    assert.equal((await read(id)).data.task[1].name, "Q's");
    assert.equal(
      (await post(id, { action: "exchange", token: "wrong" })).status,
      401,
    );
    // A link is for its own document only.
    const other = await provision(team, teamData);
    assert.equal(
      (await post(other, { action: "exchange", token: first.token })).status,
      401,
    );
    assert.equal(
      (await write(other, boss.session, on("free", "name", "Free", "No")))
        .status,
      401,
    );
    // Signing out ends that session alone.
    await post(id, { action: "signout" }, boss.session);
    assert.equal(
      (await post(id, { action: "whoami" }, boss.session)).person,
      null,
    );
    assert.equal(
      (await post(id, { action: "exchange", token: first.token })).status,
      200,
    );
  },
);
both("a visitor who is not signed in reads and cannot write", async () => {
  const id = await provision(team, teamData);
  assert.equal(
    (await server.handle({ method: "GET", document: id })).status,
    200,
  );
  for (const session of [undefined, "", "made-up"]) {
    const r = await write(id, session, on("free", "name", "Free", "Mine"), {
      kind: "title",
      before: "Example",
      value: "Mine",
    });
    assert.deepEqual([r.status, r.message], [401, "Sign in to make changes."]);
  }
  // Naming yourself in the request is not signing in.
  const claim = await post(id, {
    requestId: crypto.randomUUID(),
    operations: [on("free", "name", "Free", "Mine")],
    actor: "boss",
    person: "boss",
  });
  assert.equal(claim.status, 401);
  await assert.rejects(
    () =>
      server.apply(id, crypto.randomUUID(), [
        on("free", "name", "Free", "Mine"),
      ] as Operation[]),
    /Sign in/,
  );
  const now = await read(id);
  assert.deepEqual(
    [now.revision, now.title, now.data.task[1].name],
    [0, "Example", "Free"],
  );
  // A document closed to writing stays closed to someone signed in.
  const closed = await provision(team, teamData, false);
  await db.query("update dv_documents set public_read = true where id = $1", [
    closed,
  ]);
  const q = await signIn(closed, "q");
  assert.equal(
    (await write(closed, q, on("free", "name", "Free", "Mine"))).status,
    403,
  );
});
both(
  "the server lets only a record's owners, or the admin, change it",
  async () => {
    const id = await provision(team, teamData);
    const [p, q, boss] = await Promise.all(
      ["p", "q", "boss"].map((who) => signIn(id, who)),
    );
    const leads = (member: string, kind = "link", record = "t") => ({
      kind,
      type: "task",
      id: record,
      field: "leads",
      value: member,
    });
    // Someone else's record: no edit, no joining its owners, no deleting it.
    for (const op of [
      on("t", "name", "Task", "Taken"),
      leads("q"),
      leads("p", "unlink"),
      { kind: "delete", type: "task", id: "t", before: teamData.task[0] },
    ]) {
      const r = await write(id, q, op);
      assert.deepEqual(
        [r.status, r.message],
        [403, "Only its owners may change this."],
      );
    }
    // A refused operation undoes the allowed ones sent with it.
    assert.equal(
      (
        await write(
          id,
          q,
          on("free", "name", "Free", "Q's"),
          on("t", "name", "Task", "Taken"),
        )
      ).status,
      403,
    );
    assert.equal((await read(id)).revision, 0);
    // An unowned record is anyone's, until it has an owner.
    assert.equal(
      (
        await write(
          id,
          q,
          on("free", "name", "Free", "Q's"),
          leads("q", "link", "free"),
        )
      ).status,
      200,
    );
    assert.equal(
      (await write(id, p, on("free", "name", "Q's", "P's"))).status,
      403,
    );
    // Owners change their own, and may hand it on: then it is no longer theirs.
    assert.equal(
      (await write(id, p, on("t", "name", "Task", "Mine"), leads("q"))).status,
      200,
    );
    assert.equal(
      (await write(id, q, on("t", "status", "Open", "Done"))).status,
      200,
    );
    assert.equal((await write(id, p, leads("p", "unlink"))).status, 200);
    assert.equal(
      (await write(id, p, on("t", "name", "Mine", "Back"))).status,
      403,
    );
    // The admin may change any record.
    assert.equal(
      (await write(id, boss, on("t", "name", "Mine", "Boss's"))).status,
      200,
    );
    // Each change is logged under the person its session belongs to.
    const by = await db.query(
      "select by from dv_changes where document_id = $1 order by revision",
      [id],
    );
    assert.deepEqual(
      by.rows.map((r) => r.by),
      ["q", "p", "q", "p", "boss"],
    );
    const now = await read(id);
    assert.deepEqual(
      [now.data.task[0].name, now.data.task[0].leads],
      ["Boss's", ["q"]],
    );
  },
);
both(
  "a passcode signs its own device in, and wrong tries lock it",
  async () => {
    const id = await provision(team, teamData);
    const q = await signIn(id, "q");
    const device = crypto.randomUUID() + crypto.randomUUID();
    const enter = (passcode: unknown, d: unknown = device) =>
      post(id, { action: "passcode-signin", device: d, passcode });
    // Setting one needs a session, and a passcode worth the name.
    assert.equal(
      (await post(id, { action: "passcode-set", device, passcode: "2468" }))
        .status,
      401,
    );
    assert.equal(
      (await post(id, { action: "passcode-set", device, passcode: "24" }, q))
        .status,
      400,
    );
    assert.equal(
      (
        await post(
          id,
          { action: "passcode-set", device: "short", passcode: "2468" },
          q,
        )
      ).status,
      400,
    );
    assert.equal(
      (await post(id, { action: "passcode-set", device, passcode: "2468" }, q))
        .status,
      200,
    );
    const kept = JSON.stringify(
      (await db.query("select * from dv_passcodes")).rows,
    );
    assert.ok(!kept.includes(device) && !kept.includes("2468"));
    const back = await enter("2468");
    assert.deepEqual([back.status, back.person, back.admin], [200, "q", false]);
    assert.equal(
      (await write(id, back.session, on("free", "name", "Free", "Q's"))).status,
      200,
    );
    // The passcode is no use from another device, or on another document.
    assert.equal(
      (await enter("2468", crypto.randomUUID() + crypto.randomUUID())).status,
      401,
    );
    const other = await provision(team, teamData);
    assert.equal(
      (
        await post(other, {
          action: "passcode-signin",
          device,
          passcode: "2468",
        })
      ).status,
      401,
    );
    // Four wrong tries, then the right one: the count starts over.
    for (let n = 0; n < 4; n++) assert.equal((await enter("0000")).status, 401);
    assert.equal((await enter("2468")).status, 200);
    // Five wrong tries lock the device, against the right passcode too.
    for (let n = 0; n < 5; n++) assert.equal((await enter("0000")).status, 401);
    const locked = await enter("2468");
    assert.equal(locked.status, 429);
    assert.match(locked.message, /Try again in 15 minutes/);
    // Until the time is up.
    await db.query(
      "update dv_passcodes set locked_until = now() - interval '1 second' where document_id = $1",
      [id],
    );
    assert.equal((await enter("2468")).status, 200);
    // Setting it again replaces it.
    await post(id, { action: "passcode-set", device, passcode: "13579" }, q);
    assert.equal((await enter("2468")).status, 401);
    assert.equal((await enter("13579")).status, 200);
    // Revoking the link the passcode came from ends it and its sessions.
    const boss = await signIn(id, "boss");
    const [link] = (await post(id, { action: "links" }, boss)).links.filter(
      (l: any) => l.person === "q",
    );
    await post(id, { action: "link-revoke", id: link.id }, boss);
    assert.equal((await enter("13579")).status, 401);
    assert.equal(
      (await post(id, { action: "whoami" }, back.session)).person,
      null,
    );
    // Forgetting a device removes its passcode.
    const again = await signIn(id, "q");
    await post(id, { action: "passcode-set", device, passcode: "2468" }, again);
    await post(id, { action: "passcode-forget", device });
    assert.equal((await enter("2468")).status, 401);
  },
);
both("browsers cannot read or change the sign-in tables", async () => {
  const id = await provision(team, teamData);
  await signIn(id, "q");
  for (const role of ["anon", "authenticated"]) {
    await db.query(`set role ${role}`);
    try {
      for (const sql of [
        "select * from dv_links",
        "select * from dv_sessions",
        "select * from dv_passcodes",
        "update dv_links set revoked_at = null",
        "insert into dv_sessions(token_hash,document_id,person,link_id) select 'x',document_id,person,id from dv_links",
        "delete from dv_passcodes",
      ])
        await assert.rejects(() => db.query(sql), /permission denied/);
    } finally {
      await db.query("reset role");
    }
  }
});
both(
  "no database function is left for a browser to write through",
  async () => {
    const left = await db.query(
      "select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and proname like 'dv\\_%'",
    );
    assert.deepEqual(left.rows, []);
  },
);
