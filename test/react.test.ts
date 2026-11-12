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

test("connections reuse field controls and suppress every mutation for visitors", () => {
  const initial = { data, revision: 0 };
  const store = new DocumentStore(config, initial, {
    read: async () => initial,
    commit: async () => {
      throw Error("A visitor must not write");
    },
    subscribe: () => () => {},
  });
  store.readOnly = () => true;
  const html = renderToString(
    React.createElement(DocumentEditor, {
      store,
      initialView: "connections",
      connections: {
        groupCollection: "person",
        memberField: "leads",
        goals: [
          {
            id: "g",
            label: "Goal",
            title: "A complete goal",
            projects: { p: "Primary" },
          },
        ],
      },
    }),
  );
  assert.match(html, /A complete goal/);
  assert.match(html, /Trace Person/);
  assert.match(html, /status for Task/);
  assert.match(html, /aria-readonly="true"/);
  assert.match(
    html,
    /disabled=""[^>]*aria-label="status for Task"|aria-label="status for Task"[^>]*disabled=""/,
  );
  assert.doesNotMatch(
    html,
    /New task name|New person name|Remove person|Remove task/,
  );
});

test("connections expose creation and editing through the existing store", () => {
  const initial = { data, revision: 0 };
  const store = new DocumentStore(config, initial, {
    read: async () => initial,
    commit: async () => ({ snapshot: initial }),
    subscribe: () => () => {},
  });
  const html = renderToString(
    React.createElement(DocumentEditor, {
      store,
      initialView: "connections",
      connections: {
        groupCollection: "person",
        memberField: "leads",
        goals: [],
      },
    }),
  );
  assert.match(html, /New task name/);
  assert.match(html, /New person name/);
  assert.match(html.replace(/<!--.*?-->/g, ""), /Remove person/);
  assert.match(html, /status for Task/);
  assert.doesNotMatch(html, /excellence|assessment|project name/);
});

test("persisted goal contributions override static seeds, including an explicit None", async () => {
  const { connectionStrength } = await import("../src/connections");
  const goal = {
    id: "g",
    label: "Goal",
    title: "A full goal",
    projectField: "goal2027",
    projects: { p: "Primary" as const },
  };
  assert.equal(
    connectionStrength(goal, { id: "p", goal2027: "Unmapped" }),
    "Unmapped",
  );
  assert.equal(
    connectionStrength(goal, { id: "p", goal2027: "Supporting" }),
    "Supporting",
  );
  assert.equal(
    connectionStrength(goal, { id: "new", goal2027: "Primary" }),
    "Primary",
  );
  const nextConfig = structuredClone(config);
  nextConfig.collections.person.fields.goal2027 = {
    type: "choice",
    options: [
      { name: "Unmapped" },
      { name: "Primary" },
      { name: "Supporting" },
    ],
  };
  const initial = {
    data: { ...data, person: [{ ...data.person[0], goal2027: "Supporting" }] },
    revision: 0,
  };
  const store = new DocumentStore(nextConfig, initial, {
    read: async () => initial,
    commit: async () => ({ snapshot: initial }),
    subscribe: () => () => {},
  });
  store.readOnly = () => true;
  const html = renderToString(
    React.createElement(DocumentEditor, {
      store,
      initialView: "connections",
      connections: {
        groupCollection: "person",
        memberField: "leads",
        goals: [goal],
      },
    }),
  );
  assert.doesNotMatch(html, /Connect Goal to a project/);
  assert.doesNotMatch(html, /<select/);
  store.readOnly = () => false;
  const editableHtml = renderToString(
    React.createElement(DocumentEditor, {
      store,
      initialView: "connections",
      connections: {
        groupCollection: "person",
        memberField: "leads",
        goals: [goal],
      },
    }),
  );
  assert.match(editableHtml, /Connect Goal to a project/);
  assert.match(editableHtml, /Connect Person to a goal/);
  assert.doesNotMatch(editableHtml, /<select/);
  assert.doesNotMatch(html, /stroke-dasharray/);
});
