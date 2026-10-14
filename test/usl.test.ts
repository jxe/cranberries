import { test } from "node:test";
import assert from "node:assert/strict";
import { defineDocument } from "../src/model";
import { documentFromUsl, SchemaError } from "../src/usl";

const excellences = `
model Excellence {
  name       Text
  assessment Assessment
  leads      Person[]
  projects   Project[]

  @@views([
    { label: "By project",    line: [name, leads @label("lead"), assessment @bullet, projects @summary @label("project")], group: projects },
    { label: "By lead",       group: leads },
    { label: "By assessment", group: assessment },
  ])
}

model Project {
  name        Text
  excellences Excellence[]
}

Excellence.leads[] @fold <-> Person.excellences[]
Excellence.projects[] @fold <-> Project.excellences[]
Excellence.assessment <-> Assessment.excellences[]

model Assessment {
  @@fixed {
    Good             @color("#27815a")
    Improving        @color("#bd861a")
    Bad              @color("#c25357")
    "Current focus"  @color("#4278c0")
    "Not recorded"   @color("#9aa0aa")
  }
}
`;

test("a .usl schema becomes the same config as defineDocument", () => {
  const title = "MAI Roles, Responsibilities, Projects, and Excellences";
  assert.deepEqual(
    documentFromUsl(excellences, { title }),
    defineDocument({
      title,
      schema: {
        person: { name: "text", portrait: "text" },
        project: { name: "text" },
        excellence: {
          name: "text",
          leads: { many: "person", label: "lead" },
          projects: { many: "project", label: "project", summary: true },
          assessment: {
            choices: ["Good", "Improving", "Bad", "Current focus", "Not recorded"],
            colors: {
              Good: "#27815a",
              Improving: "#bd861a",
              Bad: "#c25357",
              "Current focus": "#4278c0",
              "Not recorded": "#9aa0aa",
            },
            bullet: true,
          },
        },
      },
      collection: "excellence",
      line: ["name", "leads", "assessment", "projects"],
      views: [
        { label: "By project", groupBy: "projects" },
        { label: "By lead", groupBy: "leads" },
        { label: "By assessment", groupBy: "assessment" },
      ],
      labels: { person: "lead", project: "project", excellence: "excellence" },
    }),
  );
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
  assert.deepEqual(config.schema.task, { name: "text", notes: "longtext" });
  assert.deepEqual(config.schema.list, { name: "text", tasks: { many: "task" } });
  assert.deepEqual(config.views, [{ label: "By list", groupBy: { collection: "list", field: "tasks" } }]);
});

test("schemas cranberries can't store are rejected with a reason", () => {
  const rejects = (source: string, message: RegExp) =>
    assert.throws(() => documentFromUsl(source, { title: "x" }), (e) => e instanceof SchemaError && message.test(e.message));
  rejects("model A { name Text\n count Int\n @@views([{ label: \"All\", line: [name] }]) }", /Text and Markdown/);
  rejects("model A { name Text\n bs B[]\n @@views([{ label: \"All\", line: [name] }]) }\nmodel B { name Text }\nA.bs[] <-> B.as[]", /@fold/);
  rejects("model A { name Text }", /@@views/);
  rejects("model A { name Tex }", /unknown-type/);
});
