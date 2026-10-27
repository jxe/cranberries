import { test, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { createServer, pgDatabase } from "../src/server";
import { documentFromUsl } from "../src/usl";
import { setupDatabase } from "../src/setup";
import type { Data, Entity, Operation } from "../src/model";
const connectionString = process.env.DV_TEST_DATABASE_URL;
if (!connectionString)
  throw Error(
    "Set DV_TEST_DATABASE_URL to an isolated database with the library migration installed.",
  );
const usl = `
main model Game {
  name        Text
  authors     Person[]
  status      Status
  description Markdown?
  ~views([{ label: "By game", line: [name, authors, status, description] }])
}
model List {
  name  Text
  games Game[]
}
Game.authors[] <-> Person.games[]
ordered List.games[] <-> Game.lists[]
Game.status <-> Status.games[]
enum Status { Draft, Polished }
`;
const config = documentFromUsl(usl, {
  title: "Games",
  owners: { game: "authors" },
  admin: "ann",
});
const person = (id: string, name: string): Entity => ({
  id,
  name,
  short: "",
  image: "",
});
const game = (id: string, authors: string[], modified?: string): Entity => ({
  id,
  name: `Game ${id}`,
  authors,
  status: "Draft",
  description: "",
  ...(modified ? { modified } : {}),
});
const data: Data = {
  person: [person("ann", "Ann"), person("bo", "Bo")],
  // Not in id order, and the second's authors not in name order.
  game: [
    game("g2", ["ann"], "2026-06-17T12:28:35.294Z"),
    game("g1", ["bo", "ann"]),
  ],
  list: [{ id: "l", name: "Best", games: ["g1", "g2"] }],
};
const pool = new pg.Pool({ connectionString, max: 4 });
const db = new pg.Client({ connectionString });
await db.connect();
const server = createServer({ database: pgDatabase(pool) });
let id = "";
// The tables hold one document's records at a time.
afterEach(async () => {
  await db.query("delete from dv_documents where id=$1", [id]);
});
after(async () => {
  await db.end();
  await pool.end();
});
const trusted = { trusted: true };
async function commit(ops: unknown[]) {
  const result: any = await server.apply(
    id,
    crypto.randomUUID(),
    ops as Operation[],
    null,
    trusted,
  );
  return { ...result, snapshot: await server.read(id, trusted) };
}
const strip = (d: Data) =>
  Object.fromEntries(
    Object.entries(d).map(([type, rows]) => [
      type,
      rows.map(({ modified: _, ...row }) => row),
    ]),
  );

test("a USL document keeps its records in its own tables", async () => {
  id = crypto.randomUUID();
  await server.provision({ documentId: id, config, data });
  const [doc] = (
    await db.query("select adaptor from dv_documents where id=$1", [id])
  ).rows;
  assert.equal(doc.adaptor, "tables");
  assert.deepEqual((await server.read(id, trusted)).data, data);
  assert.deepEqual(
    (await db.query(`select id, name from "Game" order by id`)).rows,
    [
      { id: "g1", name: "Game g1" },
      { id: "g2", name: "Game g2" },
    ],
  );
  assert.deepEqual(
    (
      await db.query(
        `select game, games_position from "List_games" order by games_position`,
      )
    ).rows,
    [
      { game: "g1", games_position: 0 },
      { game: "g2", games_position: 1 },
    ],
  );
  assert.equal(
    (await db.query("select 1 from dv_facts where document_id=$1", [id]))
      .rowCount,
    0,
  );
  // A second document may not take over the same tables.
  await assert.rejects(
    () => server.provision({ documentId: crypto.randomUUID(), config, data }),
    /same tables/,
  );
  await db.query("set role anon");
  try {
    await assert.rejects(
      () => db.query(`select * from "Game"`),
      /permission denied/,
    );
    await assert.rejects(
      () => db.query(`select * from dv_people`),
      /permission denied/,
    );
  } finally {
    await db.query("reset role");
  }
});

test("writes become row and join-table writes", async () => {
  id = crypto.randomUUID();
  await server.provision({
    documentId: id,
    config,
    data,
    publicRead: true,
    publicWrite: true,
  });
  const created = await commit([
    { kind: "create", type: "game", id: "g3", value: game("g3", ["bo"]) },
    { kind: "link", type: "list", id: "l", field: "games", value: "g3" },
    {
      kind: "set",
      type: "game",
      id: "g1",
      field: "status",
      before: "Draft",
      value: "Polished",
    },
    {
      kind: "set",
      type: "game",
      id: "g1",
      field: "description",
      before: "",
      value: "Two lines\nof it",
    },
  ]);
  assert.ok(created.change);
  const at = created.change.at;
  let now = created.snapshot.data;
  assert.deepEqual(now.list[0].games, ["g1", "g2", "g3"]);
  assert.equal(now.list[0].modified, at);
  assert.deepEqual(now.game[2], { ...game("g3", ["bo"]), modified: at });
  assert.equal(now.game[1].status, "Polished");
  assert.equal(now.game[1].description, "Two lines\nof it");
  assert.equal(now.game[1].modified, at);
  // An ordered relationship takes a new order; a stale write conflicts.
  now = (
    await commit([
      {
        kind: "set",
        type: "list",
        id: "l",
        field: "games",
        before: ["g1", "g2", "g3"],
        value: ["g3", "g1"],
      },
    ])
  ).snapshot.data;
  assert.deepEqual(now.list[0].games, ["g3", "g1"]);
  const stale = await commit([
    {
      kind: "set",
      type: "game",
      id: "g1",
      field: "status",
      before: "Draft",
      value: "Draft",
    },
  ]);
  assert.match(stale.conflict, /Someone else changed/);
  await assert.rejects(
    () =>
      commit([
        { kind: "link", type: "game", id: "g1", field: "authors", value: "x" },
      ]),
    /Missing related entity/,
  );
  // Deleting a record takes it out of every relationship.
  now = (
    await commit([
      { kind: "unlink", type: "game", id: "g1", field: "authors", value: "bo" },
      {
        kind: "delete",
        type: "game",
        id: "g3",
        before: now.game.find((g: Entity) => g.id === "g3"),
      },
      {
        kind: "delete",
        type: "person",
        id: "ann",
        before: data.person[0],
      },
    ])
  ).snapshot.data;
  assert.deepEqual(strip(now), {
    person: [person("bo", "Bo")],
    game: [
      { ...game("g2", []) },
      {
        ...game("g1", []),
        status: "Polished",
        description: "Two lines\nof it",
      },
    ],
    list: [{ id: "l", name: "Best", games: ["g1"] }],
  });
  // People are kept by the library, and ownership reads them.
  now = (
    await commit([
      {
        kind: "set",
        type: "game",
        id: "g2",
        field: "authors",
        before: [],
        value: ["bo"],
      },
    ])
  ).snapshot.data;
  assert.deepEqual(now.game[0].authors, ["bo"]);
  const rename = (person: string) =>
    server.apply(
      id,
      crypto.randomUUID(),
      [
        {
          kind: "set",
          type: "game",
          id: "g2",
          field: "name",
          before: "Game g2",
          value: "Renamed",
        },
      ],
      null,
      { person },
    );
  await assert.rejects(() => rename("someone"), /Only its owners/);
  assert.ok((await rename("bo")).change);
});

test("a document's records move from facts to tables unchanged", async () => {
  id = crypto.randomUUID();
  await server.provision({
    documentId: id,
    config,
    data,
    adaptor: "triples",
  });
  await commit([
    {
      kind: "set",
      type: "person",
      id: "bo",
      field: "short",
      before: "",
      value: "B",
    },
  ]);
  const before = await server.read(id, trusted);
  assert.equal(await server.move(id, "tables"), true);
  assert.deepEqual(await server.read(id, trusted), before);
  assert.equal(await server.move(id, "tables"), false);
  assert.deepEqual(await server.read(id, trusted), before);
});

test("setup makes the library's tables and the schema's, in a schema of their own, and again", async () => {
  const own = createServer({ database: pgDatabase(pool), schema: "own" });
  await setupDatabase({ url: connectionString, schema: "own" });
  await setupDatabase({ url: connectionString, schema: "own", usl });
  id = "";
  assert.equal(
    await own.provision({ documentId: "games", config, data }),
    true,
  );
  assert.deepEqual((await own.read("games", trusted)).data, data);
  assert.equal(
    (await db.query(`select count(*)::int n from own."Game"`)).rows[0].n,
    2,
  );
  await db.query("drop schema own cascade");
});
