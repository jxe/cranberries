import { defineDocument } from "../src/model";
import { c } from "../src/builder";
const person = c.collection("person", { name: c.text() });
const task = c.collection("task", {
  name: c.text(),
  leads: c.many(person),
  status: c.choice(["Open", "Done"]),
});
export const config = defineDocument({
  title: "Example",
  collections: [person, task],
  main: task,
  line: ["name", "leads", "status"],
  views: [
    c.view("People", { groupBy: task.fields.leads }),
    c.view("Status", { groupBy: "status" }),
  ],
});
export const data = {
  person: [{ id: "p", name: "Person" }],
  task: [{ id: "t", name: "Task", leads: ["p"], status: "Open" }],
};
