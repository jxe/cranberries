import { test } from "node:test";
import assert from "node:assert/strict";
import { c, defineDocument } from "../src/index";
import { documentFromUsl, SchemaError } from "../src/usl";

const games = `
model Game {
  name        Text
  authors     Person[]
  status      Status
  description Markdown?

  @@views([
    { label: "By game",   line: [name, authors @label("author"), status @bullet, description], sort: modified },
    { label: "By author", group: authors },
    { label: "By list",   group: lists, sort: modified },
  ])
  @@editableBy(authors)
}

model List {
  name  Text
  games Game[]
}

Game.authors[] @fold <-> Person.games[]
List.games[] @ordered @fold <-> Game.lists[]
Game.status <-> Status.games[]

model Status {
  @@fixed {
    Draft       @color("#9aa0aa")
    Playtested  @color("#bd861a")
    Polished    @color("#27815a")
  }
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
    search: true,
  });
  assert.deepEqual(config, expected);
  // Stored configs are compared as JSON, so the order of keys matters too.
  assert.equal(JSON.stringify(config), JSON.stringify(expected));
});

test("a view grouped by the other side's relationship groups by that side", () => {
  const config = documentFromUsl(
    `model Task {
  name Text
  notes Markdown?
  lists List[]
  @@views([{ label: "By list", line: [name], group: lists }])
}
model List { name Text }
List.tasks[] @fold <-> Task.lists[]
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
  rejects(
    'model A { name Text\n count Int\n @@views([{ label: "All", line: [name] }]) }',
    /Text and Markdown/,
  );
  rejects(
    'model A { name Text\n bs B[]\n @@views([{ label: "All", line: [name] }]) }\nmodel B { name Text }\nA.bs[] <-> B.as[]',
    /@fold/,
  );
  rejects(
    'model A { name Text\n @@views([{ label: "All", line: [name], sort: created }]) }',
    /modified only/,
  );
  rejects("model A { name Text }", /@@views/);
  rejects("model A { name Tex }", /unknown-type/);
});
