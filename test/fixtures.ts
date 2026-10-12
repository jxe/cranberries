import { defineDocument } from "../src/model";
export const config = defineDocument({
  title: "Example",
  schema: {
    person: { name: "text" },
    task: {
      name: "text",
      leads: { many: "person" },
      status: { choices: ["Open", "Done"] },
    },
  },
  collection: "task",
  line: ["name", "leads", "status"],
  views: [
    { label: "People", groupBy: "leads" },
    { label: "Status", groupBy: "status" },
  ],
});
export const data = {
  person: [{ id: "p", name: "Person" }],
  task: [{ id: "t", name: "Task", leads: ["p"], status: "Open" }],
};
