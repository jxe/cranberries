// Who this visitor is signed in as. A sign-in link (`?k=...`) is exchanged
// with the server function for a session token, which this browser keeps and
// sends with each request. The server decides who a token stands for; nothing
// kept here is believed without it.
import { call } from "./supabase";
import type { SignInLink } from "./auth";
export type { SignInLink };
export type SessionState = {
  // The person signed in, if anyone.
  person?: string;
  admin: boolean;
  // The person whose passcode signs this device in.
  remembered?: string;
};
export type Session = {
  state(): SessionState;
  subscribe(fn: () => void): () => void;
  token(): string | undefined;
  signOut(): Promise<void>;
  // Lets this device sign in again with only the passcode.
  setPasscode(passcode: string): Promise<void>;
  signIn(passcode: string): Promise<void>;
  // Drops the passcode kept for this device.
  forget(): Promise<void>;
  // The server no longer knows this session.
  expired(): void;
  // For the admin. `createLink` answers with the address to hand over.
  links(): Promise<SignInLink[]>;
  createLink(person: string): Promise<string>;
  revokeLink(id: string): Promise<void>;
};
const keep = (key: string) => ({
  get() {
    try {
      return localStorage.getItem(key) ?? undefined;
    } catch {
      return undefined;
    }
  },
  set(value?: string) {
    try {
      if (value) localStorage.setItem(key, value);
      else localStorage.removeItem(key);
    } catch {
      /* Without storage, signing in lasts for this visit. */
    }
  },
});
export function createSession(options: {
  endpoint: string;
  documentId: string;
}): Session & { start(): Promise<void> } {
  const { endpoint, documentId } = options;
  const saved = keep(`dv-session:${documentId}`),
    device = keep(`dv-device:${documentId}`),
    listeners = new Set<() => void>();
  let token = saved.get();
  const known = (): { secret?: string; person?: string } => {
    try {
      return JSON.parse(device.get() ?? "{}");
    } catch {
      return {};
    }
  };
  let state: SessionState = { admin: false, remembered: known().person };
  // `session` replaces the kept token, when given: null drops it.
  const change = (next: Partial<SessionState>, session?: string | null) => {
    if (session !== undefined) saved.set((token = session ?? undefined));
    state = { ...state, ...next, remembered: known().person };
    listeners.forEach((fn) => fn());
  };
  const ask = (action: string, body: object = {}) =>
    call(endpoint, documentId, { action, ...body }, token);
  const signedIn = (r: { session: string; person: string; admin: boolean }) =>
    change({ person: r.person, admin: r.admin }, r.session);
  const session: Session & { start(): Promise<void> } = {
    state: () => state,
    token: () => token,
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    async start() {
      const url = new URL(location.href),
        key = url.searchParams.get("k");
      if (key) {
        // The link's token leaves the address bar and the history at once.
        url.searchParams.delete("k");
        history.replaceState(history.state, "", url);
        try {
          return signedIn(await ask("exchange", { token: key }));
        } catch {
          /* A dead link leaves the visitor as they were. */
        }
      }
      if (!token) return;
      try {
        const me = await ask("whoami");
        if (me.person) change({ person: me.person, admin: me.admin });
        else session.expired();
      } catch {
        /* Offline: stay signed out for now, and keep the token for later. */
      }
    },
    expired: () => change({ person: undefined, admin: false }, null),
    async signOut() {
      await ask("signout").catch(() => {});
      session.expired();
    },
    async setPasscode(passcode) {
      const secret =
        known().secret ?? crypto.randomUUID() + crypto.randomUUID();
      const { person } = await ask("passcode-set", {
        device: secret,
        passcode,
      });
      device.set(JSON.stringify({ secret, person }));
      change({});
    },
    async signIn(passcode) {
      signedIn(
        await ask("passcode-signin", { device: known().secret, passcode }),
      );
    },
    async forget() {
      await ask("passcode-forget", { device: known().secret }).catch(() => {});
      device.set(undefined);
      change({});
    },
    links: async () => (await ask("links")).links,
    async createLink(person) {
      const made = await ask("link-create", { person });
      const url = new URL(location.href);
      url.search = "";
      url.hash = "";
      url.searchParams.set("k", made.token);
      return url.href;
    },
    async revokeLink(id) {
      await ask("link-revoke", { id });
    },
  };
  return session;
}
// For the in-memory demo, which has no server: the visitor is the admin, or
// the first person there is.
export function demoSession(person?: string): Session {
  const no = async () => {
    throw Error("Connect a database to use sign-in links.");
  };
  // One object, so a page watching it sees no change.
  const state = { person, admin: false };
  return {
    state: () => state,
    subscribe: () => () => {},
    token: () => undefined,
    signOut: no,
    setPasscode: no,
    signIn: no,
    forget: no,
    expired() {},
    links: no,
    createLink: no,
    revokeLink: no,
  };
}
