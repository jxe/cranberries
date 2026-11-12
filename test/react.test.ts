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
  assert.match(html, /Select Person/);
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
  assert.match(html, /aria-label="Add task"/);
  assert.doesNotMatch(html, /New task name/);
  assert.match(html, /aria-label="Add person"/);
  assert.match(html, /Options for Person/);
  assert.doesNotMatch(html.replace(/<!--.*?-->/g, ""), /Remove person/);
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

test("goal selection orders primary projects first and ignores legacy enabling links", async () => {
  const { sortConnectionProjects, connectionStrength } =
    await import("../src/connections");
  const goal = {
    id: "g",
    label: "Goal",
    title: "Full goal",
    projectField: "goal",
  };
  const projects = [
    { id: "a", goal: "Supporting" },
    { id: "b", goal: "Enabling" },
    { id: "c", goal: "Primary" },
    { id: "d", goal: "Primary" },
  ];
  assert.deepEqual(
    sortConnectionProjects(projects, goal).map((p) => p.id),
    ["c", "d", "a", "b"],
  );
  assert.deepEqual(
    projects.map((p) => p.id),
    ["a", "b", "c", "d"],
  );
  assert.equal(connectionStrength(goal, projects[1]), "Unmapped");
});

test("a selected project's related entries follow status priority before unrelated entries", async () => {
  const { sortConnectionEntries } = await import("../src/connections");
  const options = {
    groupCollection: "project",
    memberField: "projects",
    entryOrder: {
      field: "status",
      values: ["Current focus", "Bad", "Improving", "Good"],
    },
    goals: [],
  };
  const rows = [
    {
      id: "dim",
      name: "A dim focus",
      status: "Current focus",
      projects: ["other"],
    },
    { id: "good", name: "Good", status: "Good", projects: ["p"] },
    { id: "unknown", name: "Unknown", status: "Not recorded", projects: ["p"] },
    {
      id: "improving",
      name: "Improving",
      status: "Improving",
      projects: ["p"],
    },
    { id: "bad", name: "Bad", status: "Bad", projects: ["p"] },
    { id: "focus", name: "Focus", status: "Current focus", projects: ["p"] },
  ];
  assert.deepEqual(
    sortConnectionEntries(rows, [], options, { type: "project", id: "p" }).map(
      (e) => e.id,
    ),
    ["focus", "bad", "improving", "good", "unknown", "dim"],
  );
  assert.equal(rows[0].id, "dim");
});

test("a goal ranks entries by their strongest project contribution, then status", async () => {
  const { sortConnectionEntries } = await import("../src/connections");
  const options = {
    groupCollection: "project",
    memberField: "projects",
    entryOrder: {
      field: "status",
      values: ["Current focus", "Bad", "Improving", "Good"],
    },
    goals: [
      { id: "g", label: "Goal", title: "Goal", projectField: "strength" },
    ],
  };
  const projects = [
    { id: "p", strength: "Primary" },
    { id: "s", strength: "Supporting" },
    { id: "u", strength: "Unmapped" },
  ];
  const rows = [
    {
      id: "unrelated",
      name: "A unrelated",
      status: "Current focus",
      projects: ["u"],
    },
    {
      id: "support",
      name: "Support",
      status: "Current focus",
      projects: ["s"],
    },
    { id: "good", name: "Good", status: "Good", projects: ["p"] },
    { id: "shared", name: "Shared", status: "Bad", projects: ["p", "s"] },
    { id: "focus", name: "Focus", status: "Current focus", projects: ["p"] },
  ];
  assert.deepEqual(
    sortConnectionEntries(rows, projects, options, {
      type: "goal",
      id: "g",
    }).map((e) => e.id),
    ["focus", "shared", "good", "support", "unrelated"],
  );
});
