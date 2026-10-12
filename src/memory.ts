import { apply, equal, titleAfter, type Config, type Snapshot } from "./model";
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
      const title = snapshot.title ?? config.title;
      for (const op of ops) {
        if (op.kind === "title") {
          if (op.before !== title)
            return { snapshot, conflict: "The title changed." };
          continue;
        }
        const row = data[op.type]?.find((r) => r.id === op.id);
        if (op.kind === "set" && !equal(row?.[op.field], op.before))
          return { snapshot, conflict: "The field changed." };
        data = apply(config, data, op, new Date().toISOString());
      }
      snapshot = {
        data,
        revision: snapshot.revision + 1,
        title: titleAfter(title, ops),
      };
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
