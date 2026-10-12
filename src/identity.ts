// Which person this visitor says they are, remembered in the browser. It is a
// claim, not a login: anyone can pick anyone.
export type Identity = {
  get(): string | undefined;
  set(person: string | undefined): void;
  subscribe(fn: () => void): () => void;
};
export function createIdentity(documentId: string): Identity {
  const key = `dv-me:${documentId}`,
    listeners = new Set<() => void>();
  let person: string | undefined;
  try {
    person = localStorage.getItem(key) ?? undefined;
  } catch {
    /* Without storage the choice lasts for this visit. */
  }
  return {
    get: () => person,
    set(next) {
      person = next;
      try {
        if (next) localStorage.setItem(key, next);
        else localStorage.removeItem(key);
      } catch {
        /* As above. */
      }
      listeners.forEach((fn) => fn());
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}
