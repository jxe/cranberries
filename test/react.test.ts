import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToString } from "react-dom/server";
import { DocumentEditor } from "../src/react";
import { DocumentStore } from "../src/store";
import { config, data } from "./fixtures";
test("a document renders from configuration alone", () => {
  const initial = { data, revision: 0 };
  const store = new DocumentStore(config, initial, {
    read: async () => initial,
    commit: async () => ({ snapshot: initial }),
    subscribe: () => () => {},
  });
  const html = renderToString(React.createElement(DocumentEditor, { store }));
  assert.match(html, /Example/);
  assert.match(html, /Person/);
  assert.match(html, /Task/);
  assert.match(html, /Status/);
  assert.doesNotMatch(html, /excellence|assessment|project/);
});
