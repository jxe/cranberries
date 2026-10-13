// Who is asking. An admin hands a person a sign-in link; visiting it gives the
// browser a session, and someone signed in can add a passkey, which signs
// their device in again. The database keeps token hashes and public keys, so
// nothing read from it signs anyone in. Part of the server function: never
// runs in a browser.
import { createHash, randomBytes } from "node:crypto";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { Entity } from "./model";
import type { Database, Doc, Tables, Tx } from "./server";
// `trusted` callers (a seed script) skip every check. Otherwise a caller is
// the person their session belongs to, or nobody.
export type Caller = { trusted?: boolean; person?: string };
export type SignInLink = {
  id: string;
  person: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
};
// Where the page asking is served. A passkey belongs to `rpId`, the site's
// host name, and is only ever checked against the origin it was made on.
export type Site = { origin: string; rpId: string };
export const challengeMinutes = 5;
const refuse = (message: string, status: number) =>
  Object.assign(Error(message), { status });
// Tokens are long and random, so a plain hash is enough to keep them.
const hash = (secret: string) =>
  createHash("sha256").update(secret).digest("hex");
const token = () => randomBytes(32).toString("base64url");
const text = (value: unknown, min: number, max: number) =>
  typeof value === "string" && value.length >= min && value.length <= max;
export function createAuth(
  database: Database,
  t: Tables,
  find: (tx: Tx, id: string, lock?: boolean) => Promise<Doc>,
  // One of the document's people, if it has them.
  lookup: (tx: Tx, doc: Doc, id: string) => Promise<Entity | undefined>,
) {
  // A challenge is kept until it is answered or goes stale; `who` is the
  // person adding a passkey, or null when it is for signing in.
  async function remember(
    tx: Tx,
    documentId: string,
    challenge: string,
    who: string | null,
  ) {
    await tx.query(`delete from ${t("challenges")} where expires_at < now()`);
    await tx.query(
      `insert into ${t("challenges")}(challenge,document_id,person,expires_at) values ($1,$2,$3, now() + interval '${challengeMinutes} minutes')`,
      [challenge, documentId, who],
    );
  }
  // The challenge a device answered, if we set it and it is still good. It is
  // removed as it is read: an answer cannot be played back.
  async function recall(
    tx: Tx,
    documentId: string,
    response: any,
    who: string | null,
  ) {
    let challenge: unknown;
    try {
      challenge = JSON.parse(
        Buffer.from(response.response.clientDataJSON, "base64url").toString(),
      ).challenge;
    } catch {
      /* Not an answer at all. */
    }
    const [kept] = text(challenge, 1, 500)
      ? await tx.query(
          `delete from ${t("challenges")} where challenge = $1 and document_id = $2
             and person is not distinct from $3 and expires_at > now() returning challenge`,
          [challenge, documentId, who],
        )
      : [];
    if (!kept) throw refuse("That took too long. Try again.", 400);
    return challenge as string;
  }
  // The caller a session token stands for; nobody if its link was revoked.
  async function who(
    tx: Tx,
    documentId: string,
    session?: string | null,
  ): Promise<Caller & { link?: string }> {
    if (!text(session, 1, 200)) return {};
    const [row] = await tx.query<{ person: string; link_id: string }>(
      `select s.person, s.link_id from ${t("sessions")} s join ${t("links")} l on l.id = s.link_id
       where s.token_hash = $1 and s.document_id = $2 and l.revoked_at is null`,
      [hash(session as string), documentId],
    );
    return row ? { person: row.person, link: row.link_id } : {};
  }
  async function admin(tx: Tx, documentId: string, caller: Caller) {
    const doc = await find(tx, documentId);
    if (
      !caller.trusted &&
      !(caller.person && caller.person === doc.config.admin)
    )
      throw refuse("Only the admin may do this.", caller.person ? 403 : 401);
    return doc;
  }
  async function begin(
    tx: Tx,
    documentId: string,
    person: string,
    link: string,
  ) {
    const session = token();
    await tx.query(
      `insert into ${t("sessions")}(token_hash,document_id,person,link_id) values ($1,$2,$3,$4)`,
      [hash(session), documentId, person, link],
    );
    const doc = await find(tx, documentId);
    return { session, person, admin: person === doc.config.admin };
  }
  return {
    who: (documentId: string, session?: string | null) =>
      database.transaction(async (tx) => {
        const caller = await who(tx, documentId, session);
        const doc = await find(tx, documentId);
        return {
          person: caller.person ?? null,
          admin: !!caller.person && caller.person === doc.config.admin,
        };
      }),
    caller: (tx: Tx, documentId: string, session?: string | null) =>
      who(tx, documentId, session),
    // A new link for a person; for the admin when none is named, which only a
    // trusted caller may ask. The token is returned once and not kept.
    createLink: (documentId: string, person?: string, caller: Caller = {}) =>
      database.transaction(async (tx) => {
        const doc = await admin(tx, documentId, caller);
        const target =
          person ?? (caller.trusted ? doc.config.admin : undefined);
        if (!text(target, 1, 500) || !(await lookup(tx, doc, target as string)))
          throw refuse(
            person === undefined
              ? "Name the admin in the config first."
              : "Unknown person.",
            400,
          );
        const id = crypto.randomUUID(),
          secret = token();
        await tx.query(
          `insert into ${t("links")}(id,document_id,person,token_hash,created_by) values ($1,$2,$3,$4,$5)`,
          [id, documentId, target, hash(secret), caller.person ?? null],
        );
        return { id, person: target as string, token: secret };
      }),
    links: (documentId: string, caller: Caller = {}) =>
      database.transaction(async (tx) => {
        await admin(tx, documentId, caller);
        return tx.query<SignInLink>(
          `select id, person, created_at, last_used_at, revoked_at from ${t("links")}
           where document_id = $1 order by created_at desc, id`,
          [documentId],
        );
      }),
    revokeLink: (documentId: string, id: string, caller: Caller = {}) =>
      database.transaction(async (tx) => {
        await admin(tx, documentId, caller);
        if (!/^[0-9a-f-]{36}$/i.test(String(id)))
          throw refuse("Unknown link.", 404);
        const done = await tx.query(
          `update ${t("links")} set revoked_at = coalesce(revoked_at, now())
           where document_id = $1 and id = $2 returning id`,
          [documentId, id],
        );
        if (!done.length) throw refuse("Unknown link.", 404);
      }),
    // A link's token for a session. The link stays good for the next visit.
    exchange: (documentId: string, secret: unknown) =>
      database.transaction(async (tx) => {
        const [link] = text(secret, 1, 200)
          ? await tx.query<{ id: string; person: string }>(
              `update ${t("links")} set last_used_at = now()
               where token_hash = $1 and document_id = $2 and revoked_at is null returning id, person`,
              [hash(secret as string), documentId],
            )
          : [];
        if (!link) throw refuse("This sign-in link no longer works.", 401);
        return begin(tx, documentId, link.person, link.id);
      }),
    signOut: (documentId: string, session?: string | null) =>
      database.transaction(async (tx) => {
        if (text(session, 1, 200))
          await tx.query(
            `delete from ${t("sessions")} where token_hash = $1 and document_id = $2`,
            [hash(session as string), documentId],
          );
      }),
    // A passkey for the person signed in: first the options to make one with,
    // holding a challenge that is good once and not for long.
    passkeyOptions: (
      documentId: string,
      session: string | null | undefined,
      site: Site,
    ) =>
      database.transaction(async (tx) => {
        const caller = await who(tx, documentId, session);
        if (!caller.person) throw refuse("Sign in first.", 401);
        const doc = await find(tx, documentId);
        const row = await lookup(tx, doc, caller.person);
        const have = await tx.query<{ id: string }>(
          `select id from ${t("passkeys")} where document_id = $1 and person = $2 and rp_id = $3`,
          [documentId, caller.person, site.rpId],
        );
        const options = await generateRegistrationOptions({
          rpName: doc.title ?? doc.config.title,
          rpID: site.rpId,
          userID: Buffer.from(`${documentId}\n${caller.person}`),
          userName: String(row?.name ?? caller.person),
          attestationType: "none",
          excludeCredentials: have,
          // Kept by the device and found without being asked for by name.
          authenticatorSelection: {
            residentKey: "required",
            userVerification: "preferred",
          },
        });
        await remember(tx, documentId, options.challenge, caller.person);
        return options;
      }),
    // Then what the device made, checked against that challenge and this
    // site. A used challenge stays used, though what it was used for is refused.
    async addPasskey(
      documentId: string,
      session: string | null | undefined,
      site: Site,
      response: any,
    ) {
      const outcome = await database.transaction(async (tx) => {
        const caller = await who(tx, documentId, session);
        if (!caller.person) throw refuse("Sign in first.", 401);
        const expectedChallenge = await recall(
          tx,
          documentId,
          response,
          caller.person,
        );
        const checked = await verifyRegistrationResponse({
          response,
          expectedChallenge,
          expectedOrigin: site.origin,
          expectedRPID: site.rpId,
          requireUserVerification: false,
        }).catch(() => undefined);
        if (!checked?.verified || !checked.registrationInfo)
          return { error: refuse("That passkey could not be checked.", 400) };
        const { credential } = checked.registrationInfo;
        await tx.query(
          `insert into ${t("passkeys")}(id,document_id,person,link_id,rp_id,public_key,counter,transports) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            credential.id,
            documentId,
            caller.person,
            caller.link,
            site.rpId,
            Buffer.from(credential.publicKey).toString("base64url"),
            credential.counter,
            JSON.stringify(credential.transports ?? []),
          ],
        );
        return { person: caller.person };
      });
      if ("error" in outcome) throw outcome.error;
      return outcome;
    },
    // Signing in with one: the device offers whichever passkeys it has here.
    passkeySignInOptions: (documentId: string, site: Site) =>
      database.transaction(async (tx) => {
        await find(tx, documentId);
        const options = await generateAuthenticationOptions({
          rpID: site.rpId,
          userVerification: "preferred",
        });
        await remember(tx, documentId, options.challenge, null);
        return options;
      }),
    async passkeySignIn(documentId: string, site: Site, response: any) {
      const outcome = await database.transaction(async (tx) => {
        const no = {
          error: refuse("That passkey does not sign in here.", 401),
        };
        const expectedChallenge = await recall(tx, documentId, response, null);
        const [key] = text(response?.id, 1, 2000)
          ? await tx.query<{
              person: string;
              link_id: string;
              public_key: string;
              counter: string;
              transports: any;
            }>(
              `select p.person, p.link_id, p.public_key, p.counter, p.transports
               from ${t("passkeys")} p join ${t("links")} l on l.id = p.link_id
               where p.id = $1 and p.document_id = $2 and p.rp_id = $3 and l.revoked_at is null for update of p`,
              [response.id, documentId, site.rpId],
            )
          : [];
        if (!key) return no;
        const checked = await verifyAuthenticationResponse({
          response,
          expectedChallenge,
          expectedOrigin: site.origin,
          expectedRPID: site.rpId,
          requireUserVerification: false,
          credential: {
            id: response.id,
            publicKey: Buffer.from(key.public_key, "base64url"),
            counter: Number(key.counter),
            transports: key.transports,
          },
        }).catch(() => undefined);
        if (!checked?.verified) return no;
        await tx.query(
          `update ${t("passkeys")} set counter = $2, last_used_at = now() where id = $1`,
          [response.id, checked.authenticationInfo.newCounter],
        );
        return begin(tx, documentId, key.person, key.link_id);
      });
      if ("error" in outcome) throw outcome.error;
      return outcome;
    },
  };
}
