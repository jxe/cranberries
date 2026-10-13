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
  let passcode: { device: string; code: string } | undefined;
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
    if (body.action === "passcode-set") {
      passcode = { device: body.device, code: body.passcode };
      return answer(200, { person });
    }
    if (body.action === "passcode-signin")
      return passcode?.device === body.device &&
        passcode?.code === body.passcode
        ? begin()
        : answer(401, { message: "Wrong passcode." });
    if (body.action === "link-create")
      return answer(200, { id: "l", person: body.person, token: "fresh" });
    return person
      ? answer(200, { change: { revision: 1, at: "now" } })
      : answer(401, { message: "Sign in to make changes." });
  };
  return { kept, calls, sessions, href: () => g.location.href as string };
}
const start = async () => {
  const session = createSession({ endpoint: "/api", documentId: "doc" });
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
test("a passcode is remembered for the device and signs it in again", async () => {
  const b = browser("https://site.test/?k=good");
  const session = await start();
  let told = 0;
  session.subscribe(() => told++);
  await session.setPasscode("2468");
  assert.equal(session.state().remembered, "ada");
  const device = JSON.parse(b.kept.get("dv-device:doc")!);
  assert.ok(device.secret.length >= 20);
  assert.ok(!b.kept.get("dv-device:doc")!.includes("2468"));
  await session.signOut();
  assert.deepEqual(session.state(), {
    person: undefined,
    admin: false,
    remembered: "ada",
  });
  assert.equal(b.sessions.size, 0);
  // A new visit: nobody is signed in, but the device says who could be.
  const later = await start();
  assert.equal(later.state().person, undefined);
  assert.equal(later.state().remembered, "ada");
  await assert.rejects(() => later.signIn("0000"), /Wrong passcode/);
  await later.signIn("2468");
  assert.equal(later.state().person, "ada");
  assert.equal(b.calls.at(-1)!.body.device, device.secret);
  assert.ok(told >= 2);
  await later.forget();
  assert.equal(later.state().remembered, undefined);
  assert.equal(b.kept.has("dv-device:doc"), false);
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
