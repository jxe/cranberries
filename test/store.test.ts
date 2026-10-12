import { test } from "node:test";
import assert from "node:assert/strict";
import { DocumentStore, type Transport } from "../src/store";
import { apply, equal, type Snapshot, type Operation } from "../src/model";
import { config, data } from "./fixtures";
const tick = () => new Promise((r) => setTimeout(r, 5));
function server() {
  let snapshot: Snapshot = { data: structuredClone(data), revision: 0 };
  const receipts = new Set<string>(),
    listeners = new Set<(s: Snapshot) => void>();
  let loseAck = false;
  const transport: Transport = {
    read: async () => snapshot,
    subscribe(fn, status) {
      listeners.add(fn);
      status(true);
      return () => {
        listeners.delete(fn);
      };
    },
    async commit(id, ops) {
      if (receipts.has(id)) return { snapshot };
      let next = snapshot.data;
      for (const op of ops) {
        const row = next[op.type].find((r) => r.id === op.id);
        if (op.kind === "set" && !equal(row?.[op.field], op.before))
          return { snapshot, conflict: "Field conflict" };
        next = apply(config, next, op);
      }
      snapshot = { data: next, revision: snapshot.revision + 1 };
      receipts.add(id);
      listeners.forEach((fn) => fn(snapshot));
      if (loseAck) {
        loseAck = false;
        throw Error("lost response");
      }
      return { snapshot };
    },
  };
  return {
    transport,
    get: () => snapshot,
    loseAck: () => {
      loseAck = true;
    },
    count: () => listeners.size,
  };
}
test("two editors preserve disjoint edits and synchronize snapshots", async () => {
  const s = server(),
    a = new DocumentStore(config, s.get(), s.transport),
    b = new DocumentStore(config, s.get(), s.transport);
  const stopA = a.start(),
    stopB = b.start();
  await tick();
  a.set("task", "t", "name", "New");
  b.set("task", "t", "status", "Done");
  await a.flush();
  await b.flush();
  assert.equal(a.getSnapshot().data.task[0].name, "New");
  assert.equal(a.getSnapshot().data.task[0].status, "Done");
  assert.deepEqual(a.getSnapshot().data, b.getSnapshot().data);
  stopA();
  stopB();
  assert.equal(s.count(), 0);
});
test("same-field conflict retains draft and requires explicit resolution", async () => {
  const s = server(),
    a = new DocumentStore(config, s.get(), s.transport),
    b = new DocumentStore(config, s.get(), s.transport);
  const sa = a.start(),
    sb = b.start();
  await tick();
  a.set("task", "t", "name", "Alice");
  b.set("task", "t", "name", "Bob");
  await a.flush();
  await b.flush();
  assert.equal(b.getSnapshot().status, "conflict");
  assert.equal(b.getSnapshot().data.task[0].name, "Bob");
  b.useRemote();
  assert.equal(b.getSnapshot().data.task[0].name, "Alice");
  sa();
  sb();
});
test("lost acknowledgement retries identical request without a second mutation", async () => {
  const s = server(),
    a = new DocumentStore(config, s.get(), s.transport);
  const stop = a.start();
  await tick();
  s.loseAck();
  a.set("task", "t", "name", "Saved");
  await a.flush();
  assert.equal(a.getSnapshot().status, "error");
  await a.flush();
  assert.equal(s.get().revision, 1);
  assert.equal(a.getSnapshot().pending, 0);
  stop();
});
test("edits during an in-flight write survive the acknowledgement", async () => {
  const s = server();
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const transport = {
    ...s.transport,
    commit: async (id: string, ops: Operation[]) => {
      await gate;
      return s.transport.commit(id, ops);
    },
  };
  const a = new DocumentStore(config, s.get(), transport);
  const stop = a.start();
  await tick();
  a.set("task", "t", "name", "First");
  const first = a.flush();
  a.set("task", "t", "name", "Second");
  release();
  await first;
  assert.equal(a.getSnapshot().data.task[0].name, "Second");
  await a.flush();
  assert.equal(s.get().data.task[0].name, "Second");
  stop();
});
test("reconnect refreshes missed revisions and ignores stale snapshots", async () => {
  const s = server(),
    a = new DocumentStore(config, s.get(), s.transport);
  let stop = a.start();
  await tick();
  stop();
  await s.transport.commit(crypto.randomUUID(), [
    {
      kind: "set",
      type: "task",
      id: "t",
      field: "status",
      before: "Open",
      value: "Done",
    },
  ]);
  stop = a.start();
  await tick();
  a.receive({ data, revision: 0 });
  assert.equal(a.getSnapshot().data.task[0].status, "Done");
  stop();
});
test("active draft compares against text seen at focus", async () => {
  const s = server(),
    a = new DocumentStore(config, s.get(), s.transport);
  const stop = a.start();
  await tick();
  await s.transport.commit(crypto.randomUUID(), [
    {
      kind: "set",
      type: "task",
      id: "t",
      field: "name",
      before: "Task",
      value: "Remote",
    },
  ]);
  a.set("task", "t", "name", "Local", "Task");
  await a.flush();
  assert.equal(a.getSnapshot().status, "conflict");
  stop();
});

function draftStorage() {
  let value: string | null = null;
  return {
    load: () => value,
    save: (v: string) => {
      value = v;
    },
    clear: () => {
      value = null;
    },
  };
}
test("HTTP saves continue when realtime is disconnected", async () => {
  const s = server();
  const a = new DocumentStore(config, s.get(), {
    ...s.transport,
    subscribe(_receive, status) {
      status(false);
      return () => {};
    },
  });
  const stop = a.start();
  a.set("task", "t", "name", "Offline socket");
  await a.flush();
  assert.equal(s.get().data.task[0].name, "Offline socket");
  assert.equal(a.getSnapshot().status, "saved");
  assert.equal(a.getSnapshot().realtime, false);
  stop();
});
test("reload restores unsent edits and clears backup after saving", async () => {
  const s = server(),
    storage = draftStorage();
  const a = new DocumentStore(config, s.get(), s.transport, storage);
  a.set("task", "t", "name", "Recovered");
  const b = new DocumentStore(config, s.get(), s.transport, storage);
  assert.equal(b.getSnapshot().data.task[0].name, "Recovered");
  await b.flush();
  assert.equal(s.get().data.task[0].name, "Recovered");
  assert.equal(storage.load(), null);
  // Cancel the original tab's debounce to model its destruction on reload.
  a.start()();
});
test("reload after a lost acknowledgement replays the original receipt ID", async () => {
  const s = server(),
    storage = draftStorage();
  const a = new DocumentStore(config, s.get(), s.transport, storage);
  const stop = a.start();
  await tick();
  s.loseAck();
  a.set("task", "t", "name", "Once");
  await a.flush();
  stop();
  const b = new DocumentStore(config, s.get(), s.transport, storage);
  await b.flush();
  assert.equal(s.get().revision, 1);
  assert.equal(b.getSnapshot().pending, 0);
});
test("storage failure is visible but does not prevent an HTTP save", async () => {
  const s = server();
  const a = new DocumentStore(config, s.get(), s.transport, {
    load: () => null,
    save() {
      throw Error("quota");
    },
    clear() {},
  });
  a.set("task", "t", "name", "Saved anyway");
  assert.match(a.getSnapshot().storageError, /backup failed/);
  await a.flush();
  assert.equal(a.getSnapshot().pending, 0);
  assert.equal(a.getSnapshot().storageError, "");
  a.start()();
});

test("a timed-out write releases the queue and retries the same batch", async () => {
  const s = server();
  let attempts = 0;
  const ids: string[] = [];
  const a = new DocumentStore(config, s.get(), {
    ...s.transport,
    async commit(id, ops) {
      ids.push(id);
      if (attempts++ === 0)
        throw new DOMException("Request timed out", "TimeoutError");
      return s.transport.commit(id, ops);
    },
  });
  const stop = a.start();
  await tick();
  a.set("task", "t", "name", "Retry");
  await a.flush();
  assert.equal(a.getSnapshot().status, "error");
  await a.flush();
  assert.equal(a.getSnapshot().pending, 0);
  assert.equal(ids[0], ids[1]);
  stop();
});
