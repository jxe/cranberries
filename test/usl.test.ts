import { test } from "node:test";
import assert from "node:assert/strict";
import { c, defineDocument } from "../src/index";
import { documentFromUsl, SchemaError, storageOf, tablesSql } from "../src/usl";

const games = `
main model Game {
  name        Text
  authors     Person[]
  status      Status
  description Markdown?
}

model List {
  name  Text
  games Game[]
}

Game.authors[] <-> Person.games[]
ordered List.games[] <-> Game.lists[]
Game.status <-> Status.games[]

enum Status { Draft, Playtested, Polished }

re Game {
  ~views([
    { label: "By game",   line: [name, authors ~label("author"), status ~bullet, description], sort: modified },
    { label: "By author", group: authors },
    { label: "By list",   group: lists, sort: modified },
  ])
}

re Status {
  Draft      ~color("#9aa0aa")
  Playtested ~color("#bd861a")
  Polished   ~color("#27815a")
}
`;

test("a .usl schema becomes the same config as defineDocument", () => {
  const person = c.person().label("author").fixed();
  const game = c.collection("game", {
    name: c.text(),
    authors: c.many(person),
    status: c
      .choice({ Draft: "#9aa0aa", Playtested: "#bd861a", Polished: "#27815a" })
      .bullet(),
    description: c.longtext(),
  });
  const list = c.collection("list", { name: c.text(), games: c.many(game) });
  const expected = defineDocument({
    title: "Games",
    admin: "edelwax",
    collections: [
      person,
      game.label("game").ownedBy("authors"),
      list.label("list"),
    ],
    main: game,
    line: ["name", "authors", "status", "description"],
    views: [
      c.view("By game", { sort: "modified" }),
      c.view("By author", { groupBy: game.fields.authors }),
      c.view("By list", { groupBy: list.fields.games, sort: "modified" }),
    ],
    search: true,
  });
  const config = documentFromUsl(games, {
    title: "Games",
    fixed: ["person"],
    owners: { game: "authors" },
    admin: "edelwax",
    search: true,
  });
  const { usl, ...rest } = config;
  assert.deepEqual(rest, expected);
  // Stored configs are compared as JSON, so the order of keys matters too.
  assert.equal(JSON.stringify(rest), JSON.stringify(expected));
  // The config keeps its source; the server finds the tables from it.
  assert.equal(usl, games);
  const { tables, models } = storageOf(config);
  assert.deepEqual(models, { game: "Game", list: "List" });
  assert.deepEqual(
    tables.map((t) => t.name),
    ["Game", "List", "Game_authors", "List_games"],
  );
});

test("the tables' setup SQL is in the schema asked for", () => {
  const sql = tablesSql(games, "remake");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS "remake"."List_games"/);
  assert.match(sql, /revoke all on remake."Game" from anon, authenticated;/);
  assert.throws(() => tablesSql(games, "x; drop"), /Invalid schema/);
});

test("a view grouped by the other side's relationship groups by that side", () => {
  const config = documentFromUsl(
    `main model Task {
  name Text
  notes Markdown?
  lists List[]
  ~views([{ label: "By list", line: [name], group: lists }])
}
model List { name Text }
List.tasks[] <-> Task.lists[]
`,
    { title: "Tasks" },
  );
  assert.deepEqual(config.collections.task.fields, {
    name: { type: "text" },
    notes: { type: "longtext" },
  });
  assert.deepEqual(config.collections.list.fields, {
    name: { type: "text" },
    tasks: { type: "many", of: "task" },
  });
  assert.deepEqual(config.views, [
    { label: "By list", groupBy: { collection: "list", field: "tasks" } },
  ]);
});

test("schemas cranberries can't store are rejected with a reason", () => {
  const rejects = (source: string, message: RegExp) =>
    assert.throws(
      () => documentFromUsl(source, { title: "x" }),
      (e) => e instanceof SchemaError && message.test(e.message),
    );
  const views = '~views([{ label: "All", line: [name] }])';
  rejects(
    `main model A { name Text\n count Int\n ${views} }`,
    /Text and Markdown/,
  );
  rejects(
    `main model A { name Text\n b B?\n ${views} }\nmodel B { name Text }\nA.b? <-> B.as[]`,
    /many-to-many/,
  );
  rejects(
    'main model A { name Text\n ~views([{ label: "All", line: [name], sort: created }]) }',
    /modified only/,
  );
  rejects(`model A { name Text\n ${views} }`, /main model/);
  rejects("main model A { name Text }", /~views/);
  rejects("main model A { name Tex }", /unknown-type/);
  assert.throws(
    () =>
      documentFromUsl(`main model A { name Text\n ${views} }`, {
        title: "x",
        owners: { a: "authors" },
      }),
    /no field authors/,
  );
});
