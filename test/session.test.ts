import { test } from "node:test";
import assert from "node:assert/strict";
import { createSession } from "../src/session";
import { DocumentStore } from "../src/store";
import { supabaseTransport } from "../src/supabase";
import { canEdit, defineDocument } from "../src/model";
import { config, data } from "./fixtures";
// A browser's worth of globals, and a server function that knows one link.
function browser(href: string) {
  const kept = new Map<string, string>();
  const calls: { body: any; session?: string }[] = [];
  const sessions = new Map<string, string>();
  // The passkey the device made, and the challenges the server has set.
  let passkey: string | undefined;
  let challenges = 0;
  const g = globalThis as any;
  g.localStorage = {
    getItem: (k: string) => kept.get(k) ?? null,
    setItem: (k: string, v: string) => kept.set(k, v),
    removeItem: (k: string) => kept.delete(k),
  };
  g.location = { href };
  g.history = {
    state: null,
    replaceState: (_s: unknown, _t: string, url: URL) =>
      (g.location.href = String(url)),
  };
  g.fetch = async (_url: string, init: any = {}) => {
    const body = JSON.parse(init.body ?? "{}");
    const session = init.headers?.authorization?.replace("Bearer ", "");
    calls.push({ body, session });
    const person = sessions.get(session);
    const answer = (status: number, result: object) => ({
      ok: status < 400,
      status,
      json: async () => result,
    });
    const begin = () => {
      const s = `session-${sessions.size + 1}`;
      sessions.set(s, "ada");
      return answer(200, { session: s, person: "ada", admin: true });
    };
    if (body.action === "exchange")
      return body.token === "good"
        ? begin()
        : answer(401, { message: "This sign-in link no longer works." });
    if (body.action === "whoami")
      return answer(200, { person: person ?? null, admin: !!person });
    if (body.action === "signout")
      return (sessions.delete(session), answer(200, {}));
    if (/^passkey-(signin-)?options$/.test(body.action))
      return body.action === "passkey-options" && !person
        ? answer(401, { message: "Sign in first." })
        : answer(200, { challenge: `c${++challenges}` });
    if (body.action === "passkey-add") {
      passkey = body.response.made;
      return answer(200, { person });
    }
    if (body.action === "passkey-signin")
      return passkey && body.response.used === passkey
        ? begin()
        : answer(401, { message: "That passkey does not sign in here." });
    if (body.action === "link-create")
      return answer(200, { id: "l", person: body.person, token: "fresh" });
    return person
      ? answer(200, { change: { revision: 1, at: "now" } })
      : answer(401, { message: "Sign in to make changes." });
  };
  return { kept, calls, sessions, href: () => g.location.href as string };
}
// The device's side: it makes one passkey and offers it, unless told not to.
const device = { has: "key-1", cancel: false };
const webauthn = {
  startRegistration: async ({ optionsJSON }: { optionsJSON: any }) => ({
    made: device.has,
    challenge: optionsJSON.challenge,
  }),
  async startAuthentication({ optionsJSON }: { optionsJSON: any }) {
    if (device.cancel)
      throw Object.assign(
        Error("The operation either timed out or was not allowed."),
        {
          name: "NotAllowedError",
        },
      );
    return { used: device.has, challenge: optionsJSON.challenge };
  },
};
const start = async () => {
  const session = createSession({
    endpoint: "/api",
    documentId: "doc",
    webauthn,
  });
  await session.start();
  return session;
};
test("a sign-in link is exchanged for a session and leaves the address", async () => {
  const b = browser("https://site.test/games?k=good&view=2#top");
  const session = await start();
  assert.equal(b.href(), "https://site.test/games?view=2#top");
  assert.deepEqual(session.state(), {
    person: "ada",
    admin: true,
    passkeys: true,
    remembered: undefined,
  });
  assert.equal(b.kept.get("dv-session:doc"), "session-1");
  assert.ok(![...b.kept.values()].includes("good"));
  // The next visit, without the link, is still signed in.
  const again = await start();
  assert.equal(again.state().person, "ada");
  assert.equal(b.calls.at(-1)!.session, "session-1");
  // The admin's new link is an address on this site, with nothing else in it.
  assert.equal(
    await again.createLink("grace"),
    "https://site.test/games?k=fresh",
  );
});
test("a dead link signs nobody in, and a forgotten session is dropped", async () => {
  const b = browser("https://site.test/?k=revoked");
  const session = await start();
  assert.equal(b.href(), "https://site.test/");
  assert.equal(session.state().person, undefined);
  b.kept.set("dv-session:doc", "gone");
  assert.equal((await start()).state().person, undefined);
  assert.equal(b.kept.has("dv-session:doc"), false);
});
test("a passkey made while signed in signs the device in again", async () => {
  const b = browser("https://site.test/?k=good");
  const session = await start();
  let told = 0;
  session.subscribe(() => told++);
  await session.addPasskey();
  // What the device made went to the server, answering the server's challenge.
  assert.deepEqual(b.calls.at(-1)!.body, {
    action: "passkey-add",
    response: { made: "key-1", challenge: "c1" },
  });
  assert.equal(session.state().remembered, "ada");
  await session.signOut();
  assert.deepEqual(session.state(), {
    person: undefined,
    admin: false,
    passkeys: true,
    remembered: "ada",
  });
  assert.equal(b.sessions.size, 0);
  // A new visit: nobody is signed in; the page can say who signed in here last.
  const later = await start();
  assert.equal(later.state().person, undefined);
  assert.equal(later.state().remembered, "ada");
  // Backing out of the device's prompt leaves things as they were.
  device.cancel = true;
  await assert.rejects(() => later.signIn(), /No passkey was used/);
  assert.equal(later.state().person, undefined);
  device.cancel = false;
  await later.signIn();
  assert.equal(later.state().person, "ada");
  assert.equal(b.calls.at(-1)!.session, undefined);
  assert.ok(b.sessions.has(b.kept.get("dv-session:doc")!));
  assert.ok(told >= 2);
  // Nothing secret is kept by the page: a session token and a name to show.
  assert.deepEqual([...b.kept.keys()].sort(), [
    "dv-passkey:doc",
    "dv-session:doc",
  ]);
  // A passkey the server does not know signs nobody in.
  await later.signOut();
  device.has = "key-2";
  await assert.rejects(() => later.signIn(), /does not sign in here/);
  device.has = "key-1";
  // Adding one needs someone signed in.
  await assert.rejects(() => later.addPasskey(), /Sign in first/);
});
test("writes carry the session, and nothing is written without one", async () => {
  const b = browser("https://site.test/?k=good");
  const session = await start();
  const transport = supabaseTransport(
    {} as any,
    "doc",
    undefined,
    session,
    "/api",
  );
  await transport.commit("r", []);
  assert.deepEqual(b.calls.at(-1), {
    body: { requestId: "r", operations: [] },
    session: "session-1",
  });
  // The server stops knowing the session: the page finds out on its next write.
  b.sessions.clear();
  await assert.rejects(() => transport.commit("r2", []), /Sign in/);
  assert.equal(session.state().person, undefined);
  // A store with nobody signed in changes nothing, owned or not.
  const store = new DocumentStore(config, { data, revision: 0 }, transport);
  store.me = () => session.state().person;
  store.readOnly = () => !session.state().person;
  store.set("task", "t", "name", "Changed");
  store.setTitle("Changed");
  store.link("task", "t", "leads", "p", false);
  store.remove("task", "t");
  store.create("task", { id: "n", name: "New", leads: [], status: "Open" });
  assert.equal(store.getSnapshot().pending, 0);
  assert.equal(store.getSnapshot().data.task[0].name, "Task");
});
test("the admin may change a record whoever owns it", () => {
  const owned = defineDocument({
    ...config,
    admin: "boss",
    collections: {
      person: { kind: "person" },
      task: { ...config.collections.task, owners: "leads" },
    },
  });
  const row = { id: "t", name: "Task", leads: ["p"], status: "Open" };
  assert.equal(canEdit(owned, "task", row, "q"), false);
  assert.equal(canEdit(owned, "task", row, "p"), true);
  assert.equal(canEdit(owned, "task", row, "boss"), true);
  assert.equal(canEdit(owned, "task", row), false);
  assert.throws(
    () => defineDocument({ ...config, admin: "boss" }),
    /An admin is one of a collection of people/,
  );
});
