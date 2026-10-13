// Who this visitor is signed in as. A sign-in link (`?k=...`), or a passkey
// made after coming in by one, is exchanged with the server function for a
// session token, which this browser keeps and sends with each request. The server decides who a token stands for; nothing
// kept here is believed without it.
import { call } from "./supabase";
import type { SignInLink } from "./auth";
export type { SignInLink };
export type SessionState = {
  // The person signed in, if anyone.
  person?: string;
  admin: boolean;
  // Whether this page can make and use passkeys at all.
  passkeys: boolean;
  // The person a passkey was last made or used for here: a hint for the
  // page's wording, nothing more.
  remembered?: string;
};
export type Session = {
  state(): SessionState;
  subscribe(fn: () => void): () => void;
  token(): string | undefined;
  signOut(): Promise<void>;
  // Makes a passkey on this device for the person signed in.
  addPasskey(): Promise<void>;
  // Signs in with whichever passkey the device offers for this site.
  signIn(): Promise<void>;
  // The server no longer knows this session.
  expired(): void;
  // For the admin. `createLink` answers with the address to hand over.
  links(): Promise<SignInLink[]>;
  createLink(person: string): Promise<string>;
  revokeLink(id: string): Promise<void>;
};
// The browser's side of a passkey; see @simplewebauthn/browser.
export type WebAuthn = {
  startRegistration(options: { optionsJSON: any }): Promise<unknown>;
  startAuthentication(options: { optionsJSON: any }): Promise<unknown>;
};
// A passkey belongs to a host name, so a page reached by a bare IP address
// (127.0.0.1 rather than localhost) cannot have one.
const canPasskey = () =>
  typeof PublicKeyCredential !== "undefined" &&
  typeof location !== "undefined" &&
  !/^[\d.]+$|:/.test(location.hostname);
// What the browser says when someone backs out, in plainer words.
const plain = (error: unknown) => {
  const name = (error as Error)?.name;
  return name === "NotAllowedError" || name === "AbortError"
    ? Error("No passkey was used.")
    : name === "InvalidStateError"
      ? Error("This device already has a passkey for you.")
      : (error as Error);
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
  // In place of the browser's own, for tests.
  webauthn?: WebAuthn;
}): Session & { start(): Promise<void> } {
  const { endpoint, documentId } = options;
  const saved = keep(`dv-session:${documentId}`),
    hint = keep(`dv-passkey:${documentId}`),
    listeners = new Set<() => void>();
  let token = saved.get();
  const webauthn = async (): Promise<WebAuthn> =>
    options.webauthn ?? (await import("@simplewebauthn/browser"));
  let state: SessionState = {
    admin: false,
    passkeys: !!options.webauthn || canPasskey(),
    remembered: hint.get(),
  };
  // `session` replaces the kept token, when given: null drops it.
  const change = (next: Partial<SessionState>, session?: string | null) => {
    if (session !== undefined) saved.set((token = session ?? undefined));
    state = { ...state, ...next, remembered: hint.get() };
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
    async addPasskey() {
      const optionsJSON = await ask("passkey-options");
      const response = await (
        await webauthn()
      )
        .startRegistration({ optionsJSON })
        .catch((error) => Promise.reject(plain(error)));
      hint.set((await ask("passkey-add", { response })).person);
      change({});
    },
    async signIn() {
      const optionsJSON = await ask("passkey-signin-options");
      const response = await (
        await webauthn()
      )
        .startAuthentication({ optionsJSON })
        .catch((error) => Promise.reject(plain(error)));
      const made = await ask("passkey-signin", { response });
      hint.set(made.person);
      signedIn(made);
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
  const state = { person, admin: false, passkeys: false };
  return {
    state: () => state,
    subscribe: () => () => {},
    token: () => undefined,
    signOut: no,
    addPasskey: no,
    signIn: no,
    expired() {},
    links: no,
    createLink: no,
    revokeLink: no,
  };
}
