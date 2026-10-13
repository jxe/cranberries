import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToString } from "react-dom/server";
import {
  defineDocument,
  groups,
  newEntity,
  search,
  sortGroups,
  validate,
} from "../src/model";
import { c, type Infer } from "../src/builder";
import { createMemoryDocument } from "../src/memory";
import { demoSession } from "../src/session";
import { DocumentEditor } from "../src/react";
const config = defineDocument({
  title: "Shelf",
  collections: {
    person: { fixed: true, fields: { name: "text" } },
    book: {
      fields: {
        name: "text",
        writers: { type: "many", of: "person" },
        notes: "longtext",
      },
    },
    shelf: { fields: { name: "text", books: { type: "many", of: "book" } } },
  },
  main: "book",
  line: ["name", "writers", "notes"],
  views: [
    { label: "All" },
    { label: "Shelves", groupBy: { collection: "shelf", field: "books" } },
  ],
});
const data = {
  person: [{ id: "p", name: "Writer" }],
  book: [
    { id: "a", name: "A", writers: ["p"], notes: "" },
    { id: "b", name: "B", writers: [], notes: "one\ntwo" },
    { id: "c", name: "C", writers: [], notes: "" },
  ],
  shelf: [{ id: "s", name: "Shelf one", books: ["b", "a"] }],
};
test("a flat view is one unnamed group of every row", () => {
  const [all, ...rest] = groups(config, data);
  assert.equal(rest.length, 0);
  assert.deepEqual(
    all.rows.map((r) => r.id),
    ["a", "b", "c"],
  );
});
test("a reverse view follows the owner's order and collects the rest", () => {
  const [shelf, rest] = groups(config, data, config.views[1].groupBy);
  assert.equal(shelf.type, "shelf");
  assert.deepEqual(
    shelf.rows.map((r) => r.id),
    ["b", "a"],
  );
  assert.equal(rest.name, "Unassigned");
  assert.deepEqual(
    rest.rows.map((r) => r.id),
    ["c"],
  );
});
test("long text may be empty; a reverse view must point at the collection", () => {
  validate(config, data);
  assert.equal(newEntity(config, "book", "n").notes, "");
  assert.throws(() =>
    defineDocument({
      ...config,
      views: [{ label: "x", groupBy: { collection: "shelf", field: "name" } }],
    }),
  );
});
test("adding under a reverse group creates the row and its membership", async () => {
  const store = createMemoryDocument(config, { data, revision: 0 });
  const stop = store.start();
  const row = newEntity(config, "book", "n");
  store.create("book", row);
  store.link("shelf", "s", "books", "n");
  await store.flush();
  assert.deepEqual(store.getSnapshot().data.shelf[0].books, ["b", "a", "n"]);
  store.remove("book", "a");
  await store.flush();
  assert.deepEqual(store.getSnapshot().data.shelf[0].books, ["b", "n"]);
  assert.equal(store.getSnapshot().status, "saved");
  stop();
});
test("flat and reverse views render; fixed collections offer no add control", () => {
  const store = createMemoryDocument(config, { data, revision: 0 });
  const html = renderToString(React.createElement(DocumentEditor, { store }));
  assert.match(html, /one\ntwo/);
  assert.match(html, /Add notes/);
  assert.doesNotMatch(html, /Add a person/);
});
test("search matches every word across text and related names", () => {
  const all = groups(config, data);
  const ids = (q: string) =>
    search(config, data, all, q).flatMap((g) => g.rows.map((r) => r.id));
  assert.deepEqual(ids("TWO one"), ["b"]);
  assert.deepEqual(ids("writer"), ["a"]);
  assert.deepEqual(ids("nothing"), []);
  const shelves = groups(config, data, config.views[1].groupBy);
  assert.deepEqual(
    search(config, data, shelves, "shelf one")[0].rows.map((r) => r.id),
    ["b", "a"],
  );
});
test("sorting by modified puts the newest first and unstamped last", () => {
  const at: Record<string, string> = {
    "book:a": "2026-01-01",
    "book:c": "2026-02-01",
    "shelf:s": "2026-03-01",
  };
  const stamp = (type: string, id: string) => at[`${type}:${id}`];
  const flat = sortGroups(
    { label: "x", sort: "modified" },
    groups(config, data),
    stamp,
    "book",
  );
  assert.deepEqual(
    flat[0].rows.map((r) => r.id),
    ["c", "a", "b"],
  );
  const view = { ...config.views[1], sort: "modified" as const };
  const [shelf] = sortGroups(
    view,
    groups(config, data, view.groupBy),
    stamp,
    "book",
  );
  assert.equal(shelf.id, "s");
  assert.deepEqual(
    shelf.rows.map((r) => r.id),
    ["b", "a"],
  );
});
test("a commit stamps the written record; the unsaved overlay does not", async () => {
  const store = createMemoryDocument(config, { data, revision: 0 });
  const stop = store.start();
  store.set("book", "a", "name", "A2");
  assert.equal(store.getSnapshot().data.book[0].modified, undefined);
  await store.flush();
  const [a, b] = store.getSnapshot().data.book;
  assert.match(a.modified!, /^\d{4}-\d\d-\d\dT/);
  assert.equal(b.modified, undefined);
  store.remove("book", "a");
  await store.flush();
  assert.equal(store.getSnapshot().status, "saved");
  assert.throws(() =>
    defineDocument({
      ...config,
      collections: {
        ...config.collections,
        book: {
          fields: { ...config.collections.book.fields, modified: "text" },
        },
      },
    }),
  );
  stop();
});
test("builders produce the stored shape; a person has built-in fields", () => {
  const person = c.person().label("author").fixed();
  const status = c.choice({ Draft: "#999", Done: "#090" }).bullet();
  const game = c.collection("game", {
    name: c.text(),
    authors: c.many(person),
    status,
    notes: c.longtext().default("None yet"),
  });
  const list = c.collection("list", { name: c.text(), games: c.many(game) });
  const built = defineDocument({
    title: "Games",
    collections: [person, game, list],
    main: game,
    line: ["name", "authors", "status"],
    views: [
      c.view("Authors", { groupBy: game.fields.authors }),
      c.view("Lists", { groupBy: list.fields.games, sort: "modified" }),
    ],
  });
  assert.deepEqual(JSON.parse(JSON.stringify(built)), {
    title: "Games",
    collections: {
      person: {
        kind: "person",
        label: "author",
        fixed: true,
        fields: {
          name: { type: "text" },
          short: { type: "text" },
          image: { type: "text" },
        },
      },
      game: {
        fields: {
          name: { type: "text" },
          authors: { type: "many", of: "person" },
          status: {
            type: "choice",
            options: [
              { name: "Draft", color: "#999" },
              { name: "Done", color: "#090" },
            ],
            bullet: true,
          },
          notes: { type: "longtext", default: "None yet" },
        },
      },
      list: {
        fields: {
          name: { type: "text" },
          games: { type: "many", of: "game" },
        },
      },
    },
    main: "game",
    line: ["name", "authors", "status"],
    views: [
      { label: "Authors", groupBy: "authors" },
      {
        label: "Lists",
        groupBy: { collection: "list", field: "games" },
        sort: "modified",
      },
    ],
  });
  const row: Infer<typeof game> = {
    id: "g",
    name: "G",
    authors: [],
    status: "Draft",
    notes: "",
  };
  assert.equal(newEntity(built, "game", "n").notes, "None yet");
  assert.equal(row.status, "Draft");
  // @ts-expect-error a choice is typed by its options
  row.status = "Other";
});
test("people show an avatar: their picture, or initials", () => {
  const people = defineDocument({
    title: "Team",
    collections: {
      person: { kind: "person" },
      job: { fields: { name: "text", who: { type: "many", of: "person" } } },
    },
    main: "job",
    line: ["name", "who"],
    views: [{ label: "All" }],
  });
  const store = createMemoryDocument(people, {
    data: {
      person: [
        { id: "a", name: "Ada Lovelace", short: "Ada", image: "" },
        { id: "g", name: "Grace Hopper", short: "", image: "/grace.png" },
      ],
      job: [{ id: "j", name: "Job", who: ["a", "g"] }],
    },
    revision: 0,
  });
  const html = renderToString(React.createElement(DocumentEditor, { store }));
  // Nobody picks who they are: the menu is for whoever a session signed in.
  const page = (session: ReturnType<typeof demoSession>) =>
    renderToString(React.createElement(DocumentEditor, { store, session }));
  assert.doesNotMatch(html, /Read only|Your account/);
  assert.match(page(demoSession()), /Read only/);
  // A page watches the session's state, so it must not change unprompted.
  const demo = demoSession("a");
  assert.equal(demo.state(), demo.state());
  assert.match(page(demoSession("a")), /aria-label="Your account"/);
  assert.match(
    page({
      ...demoSession(),
      state: () => ({ admin: false, passkeys: true, remembered: "g" }),
    }),
    />Sign in as Grace Hopper</,
  );
  assert.match(html, /dv-avatar[^>]*>Ad</);
  assert.match(html, /src="\/grace.png"/);
  assert.match(html, />Ada</);
});
test("the title is saved with the document and starts as the config's", async () => {
  const store = createMemoryDocument(config, { data, revision: 0 });
  const stop = store.start();
  assert.equal(store.getSnapshot().title, "Shelf");
  store.setTitle("My shelf");
  store.setTitle("  ");
  store.setTitle("Our shelf");
  assert.equal(store.getSnapshot().title, "Our shelf");
  assert.equal(store.getSnapshot().pending, 1);
  await store.flush();
  assert.equal(store.getSnapshot().title, "Our shelf");
  assert.equal(store.getSnapshot().status, "saved");
  store.setTitle("Stale", "Shelf");
  await store.flush();
  assert.equal(store.getSnapshot().status, "conflict");
  store.receive({
    revision: 2,
    at: "now",
    operations: [{ kind: "title", before: "Our shelf", value: "Theirs" }],
  });
  store.useRemote();
  assert.equal(store.getSnapshot().title, "Theirs");
  assert.match(
    renderToString(React.createElement(DocumentEditor, { store })),
    /aria-label="Document title"[^>]*>Theirs</,
  );
  stop();
});
