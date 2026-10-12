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
import { createMemoryDocument } from "../src/memory";
import { DocumentEditor } from "../src/react";
const config = defineDocument({
  title: "Shelf",
  schema: {
    person: { name: "text" },
    book: { name: "text", writers: { many: "person" }, notes: "longtext" },
    shelf: { name: "text", books: { many: "book" } },
  },
  collection: "book",
  line: ["name", "writers", "notes"],
  views: [
    { label: "All" },
    { label: "Shelves", groupBy: { collection: "shelf", field: "books" } },
  ],
  fixed: ["person"],
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
      views: [
        { label: "x", groupBy: { collection: "book", field: "writers" } },
      ],
    }),
  );
});
test("adding under a reverse group creates the row and its membership", async () => {
  const store = createMemoryDocument(config, { data, revision: 0 });
  const stop = store.start();
  const row = newEntity(config, "book", "n");
  store.create("book", row);
  store.set("shelf", "s", "books", ["b", "a", "n"]);
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
      schema: {
        ...config.schema,
        book: { ...config.schema.book, modified: "text" },
      },
    }),
  );
  stop();
});
