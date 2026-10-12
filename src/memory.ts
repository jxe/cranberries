import { apply, equal, type Config, type Snapshot } from "./model";
import { DocumentStore } from "./store";
// In-memory transport for demos and tests. Edits are lost on reload.
export function createMemoryDocument(config: Config, initial: Snapshot) {
  let snapshot = initial;
  let receive: ((s: Snapshot) => void) | undefined;
  const requests = new Set<string>();
  return new DocumentStore(config, snapshot, {
    async read() {
      return snapshot;
    },
    async commit(id, ops) {
      if (requests.has(id)) return { snapshot };
      let data = snapshot.data;
      for (const op of ops) {
        const row = data[op.type]?.find((r) => r.id === op.id);
        if (op.kind === "set" && !equal(row?.[op.field], op.before))
          return { snapshot, conflict: "The field changed." };
        data = apply(config, data, op, new Date().toISOString());
      }
      snapshot = { data, revision: snapshot.revision + 1 };
      requests.add(id);
      receive?.(snapshot);
      return { snapshot };
    },
    subscribe(fn, status) {
      receive = fn;
      status(true);
      return () => {
        receive = undefined;
      };
    },
  });
}
