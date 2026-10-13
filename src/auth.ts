// Who is asking. An admin hands a person a sign-in link; visiting it gives the
// browser a session, and a session can set a passcode that signs the same
// device in again. The database keeps hashes only, so nothing read from it
// signs anyone in. Part of the server function: never runs in a browser.
import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
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
export const passcodeTries = 5,
  passcodeLockMinutes = 15;
const refuse = (message: string, status: number) =>
  Object.assign(Error(message), { status });
// Tokens are long and random, so a plain hash is enough to keep them.
const hash = (secret: string) =>
  createHash("sha256").update(secret).digest("hex");
const token = () => randomBytes(32).toString("base64url");
// A passcode is short, so it is stretched, with a salt of its own.
const stretch = (passcode: string, salt: string) =>
  new Promise<Buffer>((resolve, reject) =>
    scrypt(passcode, salt, 32, (error, key) =>
      error ? reject(error) : resolve(key),
    ),
  );
const text = (value: unknown, min: number, max: number) =>
  typeof value === "string" && value.length >= min && value.length <= max;
export function createAuth(
  database: Database,
  t: Tables,
  find: (tx: Tx, id: string, lock?: boolean) => Promise<Doc>,
  // Whether the document has this person.
  known: (tx: Tx, doc: Doc, person: string) => Promise<boolean>,
) {
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
        if (!text(target, 1, 500) || !(await known(tx, doc, target as string)))
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
    // `device` is a random secret the browser keeps; it says which passcode
    // to check, and the passcode alone signs nobody in without it.
    setPasscode: (
      documentId: string,
      session: string | null | undefined,
      device: unknown,
      passcode: unknown,
    ) =>
      database.transaction(async (tx) => {
        const caller = await who(tx, documentId, session);
        if (!caller.person) throw refuse("Sign in first.", 401);
        if (!text(device, 20, 200)) throw refuse("Invalid device.", 400);
        if (!text(passcode, 4, 100))
          throw refuse("Use a passcode of at least 4 characters.", 400);
        const salt = token();
        await tx.query(
          `insert into ${t("passcodes")}(document_id,device_hash,person,link_id,salt,passcode_hash) values ($1,$2,$3,$4,$5,$6)
           on conflict (document_id, device_hash) do update set person = excluded.person, link_id = excluded.link_id,
             salt = excluded.salt, passcode_hash = excluded.passcode_hash, failures = 0, locked_until = null, created_at = now()`,
          [
            documentId,
            hash(device as string),
            caller.person,
            caller.link,
            salt,
            (await stretch(passcode as string, salt)).toString("hex"),
          ],
        );
        return { person: caller.person };
      }),
    forgetPasscode: (documentId: string, device: unknown) =>
      database.transaction(async (tx) => {
        if (text(device, 20, 200))
          await tx.query(
            `delete from ${t("passcodes")} where document_id = $1 and device_hash = $2`,
            [documentId, hash(device as string)],
          );
      }),
    async passcodeSignIn(
      documentId: string,
      device: unknown,
      passcode: unknown,
    ) {
      // A wrong try is counted and committed before it is refused.
      const outcome = await database.transaction(async (tx) => {
        const wrong = { error: refuse("Wrong passcode.", 401) };
        if (!text(device, 20, 200) || !text(passcode, 1, 100)) return wrong;
        const at = [documentId, hash(device as string)];
        const [row] = await tx.query<{
          person: string;
          link_id: string;
          salt: string;
          passcode_hash: string;
          failures: number;
          wait: string | null;
        }>(
          `select p.person, p.link_id, p.salt, p.passcode_hash, p.failures,
             ceil(extract(epoch from p.locked_until - now()) / 60) as wait
           from ${t("passcodes")} p join ${t("links")} l on l.id = p.link_id
           where p.document_id = $1 and p.device_hash = $2 and l.revoked_at is null for update of p`,
          at,
        );
        if (!row) return wrong;
        if (Number(row.wait) > 0)
          return {
            error: refuse(
              `Too many wrong tries. Try again in ${row.wait} ${Number(row.wait) === 1 ? "minute" : "minutes"}.`,
              429,
            ),
          };
        const given = await stretch(passcode as string, row.salt);
        if (!timingSafeEqual(given, Buffer.from(row.passcode_hash, "hex"))) {
          const out = row.failures + 1 >= passcodeTries;
          await tx.query(
            `update ${t("passcodes")} set failures = $3, locked_until = ${out ? `now() + interval '${passcodeLockMinutes} minutes'` : "null"}
             where document_id = $1 and device_hash = $2`,
            [...at, out ? 0 : row.failures + 1],
          );
          return wrong;
        }
        await tx.query(
          `update ${t("passcodes")} set failures = 0, locked_until = null where document_id = $1 and device_hash = $2`,
          at,
        );
        return begin(tx, documentId, row.person, row.link_id);
      });
      if ("error" in outcome) throw outcome.error;
      return outcome;
    },
  };
}
