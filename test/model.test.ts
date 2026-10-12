import { test } from "node:test";
import assert from "node:assert/strict";
import { defineDocument, groups, apply, validate } from "../src/model";
import { config, data } from "./fixtures";
test("rename keeps identity and memberships; delete removes references", () => {
  const renamed = apply(config, data, {
    kind: "set",
    type: "person",
    id: "p",
    field: "name",
    before: "Person",
    value: "Renamed",
  });
  assert.equal(groups(config, renamed, "leads")[0].name, "Renamed");
  assert.equal(groups(config, renamed, "leads")[0].rows[0].id, "t");
  const removed = apply(config, renamed, {
    kind: "delete",
    type: "person",
    id: "p",
    before: renamed.person[0],
  });
  assert.deepEqual(removed.task[0].leads, []);
  validate(config, removed);
  assert.equal(groups(config, removed, "leads")[0].name, "Unassigned");
});
test("schema rejects dangling relationships and invalid choices", () => {
  assert.throws(() =>
    validate(config, {
      ...data,
      task: [{ ...data.task[0], leads: ["missing"] }],
    }),
  );
  assert.throws(() =>
    validate(config, { ...data, task: [{ ...data.task[0], status: "wrong" }] }),
  );
});
