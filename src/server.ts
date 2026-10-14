// The write path as a server function. One request is one database
// transaction: the core here checks permission, retries and each operation
// against the config, calls the storage adaptor, and logs the write in
// dv_changes. Adaptors are TypeScript, and the database holds only tables.
//
// Runs wherever there is a Postgres connection: a Vercel function, a Vite dev
// server, a test. It holds a database secret, so it never runs in a browser.
import { isDeepStrictEqual } from "node:util";
import { createAuth, type Caller } from "./auth";
import { tables } from "./tables";
import {
  canEdit,
  checkValue,
  validate,
  type Change,
  type Config,
  type Data,
  type Entity,
  type Operation,
  type Snapshot,
} from "./model";
// A connection inside one transaction, and something that can open one.
export type Tx = {
  query<T = Record<string, any>>(sql: string, params?: unknown[]): Promise<T[]>;
};
export type Database = {
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
};
export type Doc = {
  id: string;
  config: Config;
  title: string | null;
  adaptor: string;
  revision: number;
  public_read: boolean;
  public_write: boolean;
};
type RecordOp = Exclude<Operation, { kind: "title" }>;
// Where a document's records live. `t` names a table in the library's schema,
// and `t.schema` is that schema.
export type Adaptor = {
  read(tx: Tx, t: Tables, doc: Doc): Promise<Data>;
  // One record as it is stored now, if it exists.
  get(
    tx: Tx,
    t: Tables,
    doc: Doc,
    type: string,
    id: string,
  ): Promise<Entity | undefined>;
  // Applies one operation, or returns why it conflicts with what is stored.
  apply(
    tx: Tx,
    t: Tables,
    doc: Doc,
    op: RecordOp,
    stamp: string,
  ): Promise<string | null>;
  // Replaces all of the document's records.
  init(tx: Tx, t: Tables, doc: Doc, data: Data): Promise<void>;
  // Makes whatever the records need that is missing, such as their tables.
  // Runs before a document is provisioned, configured or moved here.
  setup?(tx: Tx, t: Tables, config: Config): Promise<void>;
};
export type Tables = ((
  name:
    | "documents"
    | "changes"
    | "facts"
    | "people"
    | "links"
    | "sessions"
    | "passkeys"
    | "challenges",
) => string) & { schema: string };
type Fact = {
  collection: string;
  record: string;
  field: string;
  value: string;
};
// A record from its facts; a field with no fact reads as its default.
function fromFacts(config: Config, type: string, id: string, facts: Fact[]) {
  const row: Entity = { id };
  const modified = facts.find((f) => f.field === "modified");
  if (modified) row.modified = modified.value;
  for (const [name, d] of Object.entries(config.collections[type].fields)) {
    const own = facts.filter((f) => f.field === name).map((f) => f.value);
    row[name] =
      d.type === "many"
        ? own
        : (own[0] ??
          d.default ??
          (d.type === "choice" ? d.options[0].name : ""));
  }
  return row;
}
// One fact per row in dv_facts. A record exists while it has an `id` fact,
// whose seq orders the collection; a relationship is one fact per member.
export const triples: Adaptor = {
  async read(tx, t, doc) {
    const facts = await tx.query<Fact & { seq: string }>(
      `select collection, record, field, value from ${t("facts")} where document_id = $1 order by position, seq`,
      [doc.id],
    );
    const ids = await tx.query<Fact>(
      `select collection, record from ${t("facts")} where document_id = $1 and field = 'id' order by seq`,
      [doc.id],
    );
    const of = new Map<string, Fact[]>();
    for (const f of facts) {
      const key = `${f.collection}\n${f.record}`;
      of.set(key, [...(of.get(key) ?? []), f]);
    }
    return Object.fromEntries(
      Object.keys(doc.config.collections).map((type) => [
        type,
        ids
          .filter((r) => r.collection === type)
          .map((r) =>
            fromFacts(
              doc.config,
              type,
              r.record,
              of.get(`${type}\n${r.record}`) ?? [],
            ),
          ),
      ]),
    );
  },
  async get(tx, t, doc, type, id) {
    const facts = await tx.query<Fact>(
      `select collection, record, field, value from ${t("facts")} where document_id = $1 and collection = $2 and record = $3 order by position, seq`,
      [doc.id, type, id],
    );
    return facts.some((f) => f.field === "id")
      ? fromFacts(doc.config, type, id, facts)
      : undefined;
  },
  async init(tx, t, doc, data) {
    await tx.query(`delete from ${t("facts")} where document_id = $1`, [
      doc.id,
    ]);
    for (const type of Object.keys(doc.config.collections))
      for (const row of data[type] ?? [])
        await insert(tx, t, doc, type, row, false);
  },
  async apply(tx, t, doc, op, stamp) {
    const at = [doc.id, op.type, op.id];
    const where = `document_id = $1 and collection = $2 and record = $3`;
    const facts = await tx.query<Fact>(
      `select collection, record, field, value from ${t("facts")} where ${where} order by position, seq`,
      at,
    );
    const present = facts.some((f) => f.field === "id");
    const current = fromFacts(doc.config, op.type, op.id, facts);
    const same = (a: unknown, b: unknown) =>
      JSON.stringify(a) === JSON.stringify(b);
    if (op.kind === "create") {
      if (present) return "An entity with this ID already exists.";
      await insert(tx, t, doc, op.type, { ...op.value, modified: stamp });
      return null;
    }
    if (op.kind === "delete") {
      const { modified: _a, ...now } = current,
        { modified: _b, ...before } = op.before;
      const keys = (o: object) => Object.entries(o).sort();
      if (!present || !same(keys(now), keys(before)))
        return "The entity changed before deletion.";
      await tx.query(`delete from ${t("facts")} where ${where}`, at);
      // Every relationship to the record goes with it.
      for (const [type, c] of Object.entries(doc.config.collections))
        for (const [name, d] of Object.entries(c.fields))
          if (d.type === "many" && d.of === op.type)
            await tx.query(
              `delete from ${t("facts")} where document_id = $1 and collection = $2 and field = $3 and value = $4`,
              [doc.id, type, name, op.id],
            );
      return null;
    }
    const field = doc.config.collections[op.type].fields[op.field];
    const members = current[op.field] as string[];
    let next: string[];
    if (op.kind === "set") {
      if (!present || !same(current[op.field], op.before))
        return "Someone else changed this field. Your draft is retained; copy it before using the shared version.";
      next =
        field.type === "many" ? (op.value as string[]) : [op.value as string];
    } else if (op.kind === "link") {
      if (!present) return "The entity no longer exists.";
      if (members.includes(op.value)) return null;
      next = [...members, op.value];
    } else {
      if (!members.includes(op.value)) return null;
      next = members.filter((m) => m !== op.value);
    }
    await tx.query(`delete from ${t("facts")} where ${where} and field = $4`, [
      ...at,
      op.field,
    ]);
    await put(tx, t, doc, op.type, op.id, op.field, next);
    if (field.type === "many") await related(tx, t, doc, field.of, next);
    await tx.query(
      `insert into ${t("facts")}(document_id,collection,record,field,value) values ($1,$2,$3,'modified',$4)
       on conflict (document_id,collection,record,field,position) do update set value = excluded.value`,
      [...at, stamp],
    );
    return null;
  },
};
const put = (
  tx: Tx,
  t: Tables,
  doc: Doc,
  type: string,
  id: string,
  field: string,
  values: string[],
) =>
  values.length
    ? tx.query(
        `insert into ${t("facts")}(document_id,collection,record,field,position,value)
         select $1,$2,$3,$4,(n - 1)::int,v from unnest($5::text[]) with ordinality u(v,n)`,
        [doc.id, type, id, field, values],
      )
    : Promise.resolve([]);
async function related(
  tx: Tx,
  t: Tables,
  doc: Doc,
  type: string,
  ids: string[],
) {
  const [{ n }] = await tx.query<{ n: string }>(
    `select count(*) n from ${t("facts")} where document_id = $1 and collection = $2 and field = 'id' and record = any($3::text[])`,
    [doc.id, type, ids],
  );
  if (Number(n) !== ids.length) throw Error("Missing related entity");
}
// `check` confirms related records exist; a whole document is checked beforehand.
async function insert(
  tx: Tx,
  t: Tables,
  doc: Doc,
  type: string,
  row: Entity,
  check = true,
) {
  await put(tx, t, doc, type, row.id, "id", [""]);
  if (row.modified)
    await put(tx, t, doc, type, row.id, "modified", [row.modified]);
  for (const [name, d] of Object.entries(doc.config.collections[type].fields)) {
    const v = row[name];
    if (v === undefined) continue;
    await put(
      tx,
      t,
      doc,
      type,
      row.id,
      name,
      d.type === "many" ? (v as string[]) : [v as string],
    );
    if (d.type === "many" && check)
      await related(tx, t, doc, d.of, v as string[]);
  }
}
class Conflict extends Error {}
const refuse = (message: string, status = 400) =>
  Object.assign(Error(message), { status });
// One operation against the config, before the adaptor sees it.
function checkOperation(config: Config, op: RecordOp) {
  const fields = config.collections[op.type]?.fields;
  if (!fields) throw refuse("Unknown collection");
  if (typeof op.id !== "string" || !op.id) throw refuse("Invalid ID");
  if (op.kind === "set" || op.kind === "link" || op.kind === "unlink") {
    const field = fields[op.field];
    if (!field) throw refuse("Unknown field");
    if (op.kind === "set") checkValue(field, op.value);
    else if (field.type !== "many" || typeof op.value !== "string")
      throw refuse("Invalid relationship");
  } else if (op.kind === "create") {
    if (op.value?.id !== op.id) throw refuse("ID mismatch");
    for (const [name, v] of Object.entries(op.value)) {
      if (name === "id" || name === "modified") continue;
      if (!fields[name]) throw refuse("Unknown field");
      checkValue(fields[name], v);
    }
  } else if (op.kind !== "delete") throw refuse("Unknown operation");
}
export type ServerOptions = {
  database: Database;
  // Where the library's tables are, when not `public`.
  schema?: string;
  adaptors?: Record<string, Adaptor>;
  // The sites whose pages may make and use passkeys, as origins
  // ("https://my.site"). Without it, the site the function itself is on.
  origins?: string[];
};
export type { Caller, SignInLink } from "./auth";
export function createServer(options: ServerOptions) {
  const schema = options.schema ?? "public";
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw Error("Invalid schema name.");
  const t: Tables = Object.assign((name: string) => `${schema}.dv_${name}`, {
    schema,
  });
  const adaptors: Record<string, Adaptor> = {
    triples,
    tables,
    ...options.adaptors,
  };
  const { database } = options;
  async function find(tx: Tx, id: string, lock = false) {
    const [doc] = await tx.query<Doc & { revision: string }>(
      `select id, config, title, adaptor, revision, public_read, public_write from ${t("documents")} where id = $1${lock ? " for update" : ""}`,
      [id],
    );
    if (!doc) throw refuse("Document unavailable", 404);
    if (!adaptors[doc.adaptor]) throw refuse(`No ${doc.adaptor} adaptor`, 500);
    return { ...doc, revision: Number(doc.revision) } as Doc;
  }
  const snapshot = async (tx: Tx, doc: Doc): Promise<Snapshot> => ({
    data: await adaptors[doc.adaptor].read(tx, t, doc),
    revision: doc.revision,
    title: doc.title ?? doc.config.title,
  });
  const auth = createAuth(database, t, find, async (tx, doc, id) => {
    const people = Object.keys(doc.config.collections).find(
      (type) => doc.config.collections[type].kind === "person",
    );
    return people
      ? adaptors[doc.adaptor].get(tx, t, doc, people, id)
      : undefined;
  });
  async function read(documentId: string, caller: Caller = {}) {
    return database.transaction(async (tx) => {
      const doc = await find(tx, documentId);
      if (!doc.public_read && !caller.trusted)
        throw refuse("Document unavailable", 404);
      return snapshot(tx, doc);
    });
  }
  // Anyone signed in may write a document that is open to writing, within
  // what its owned collections allow. The change is logged under the caller's
  // person; `actor` names the writer only for a trusted caller, who has none.
  async function apply(
    documentId: string,
    requestId: string,
    operations: Operation[],
    actor: string | null = null,
    caller: Caller = {},
  ): Promise<{
    snapshot?: Snapshot;
    change?: Omit<Change, "operations">;
    conflict?: string;
  }> {
    try {
      return await database.transaction(async (tx) => {
        const doc = await find(tx, documentId, true);
        if (!caller.trusted) {
          if (!caller.person) throw refuse("Sign in to make changes.", 401);
          if (!doc.public_write) throw refuse("Not allowed", 403);
        }
        const [seen] = await tx.query(
          `select 1 from ${t("changes")} where document_id = $1 and request_id = $2`,
          [documentId, requestId],
        );
        if (seen) return { snapshot: await snapshot(tx, doc) };
        if (
          !Array.isArray(operations) ||
          operations.length < 1 ||
          operations.length > 1000
        )
          throw refuse("Invalid operations");
        const stamp = new Date().toISOString();
        for (const op of operations) {
          if (op.kind === "title") {
            if (
              typeof op.value !== "string" ||
              !op.value.trim() ||
              op.value.length > 500
            )
              throw refuse("Invalid title");
            if ((doc.title ?? doc.config.title) !== op.before)
              throw new Conflict("Someone else changed the title.");
            doc.title = op.value;
            continue;
          }
          checkOperation(doc.config, op);
          // Ownership is judged on the record as stored, before this change.
          if (
            !caller.trusted &&
            op.kind !== "create" &&
            doc.config.collections[op.type].owners
          ) {
            const row = await adaptors[doc.adaptor].get(
              tx,
              t,
              doc,
              op.type,
              op.id,
            );
            if (row && !canEdit(doc.config, op.type, row, caller.person))
              throw refuse("Only its owners may change this.", 403);
          }
          const conflict = await adaptors[doc.adaptor].apply(
            tx,
            t,
            doc,
            op,
            stamp,
          );
          if (conflict) throw new Conflict(conflict);
        }
        const revision = doc.revision + 1;
        await tx.query(
          `update ${t("documents")} set revision = $2, title = $3 where id = $1`,
          [documentId, revision, doc.title],
        );
        await tx.query(
          `insert into ${t("changes")}(document_id,revision,request_id,at,by,operations) values ($1,$2,$3,$4,$5,$6)`,
          [
            documentId,
            revision,
            requestId,
            stamp,
            caller.trusted ? actor : caller.person,
            JSON.stringify(operations),
          ],
        );
        return { change: { revision, at: stamp } };
      });
    } catch (error) {
      // The transaction is undone; answer with what is stored now.
      if (!(error instanceof Conflict)) throw error;
      return {
        conflict: error.message,
        snapshot: await read(documentId, caller),
      };
    }
  }
  // Trusted setup. An existing document is left untouched. A document
  // described in USL keeps its records in its own tables (see tables.ts),
  // which this makes when they are missing, as configure and move do.
  async function provision(setup: {
    documentId: string;
    config: Config;
    data: Data;
    publicRead?: boolean;
    publicWrite?: boolean;
    adaptor?: string;
  }) {
    validate(setup.config, setup.data);
    return database.transaction(async (tx) => {
      const made = await tx.query(
        `insert into ${t("documents")}(id,config,adaptor,public_read,public_write) values ($1,$2,$3,$4,$5) on conflict (id) do nothing returning id`,
        [
          setup.documentId,
          JSON.stringify(setup.config),
          setup.adaptor ?? (setup.config.usl ? "tables" : "triples"),
          setup.publicRead ?? false,
          setup.publicWrite ?? false,
        ],
      );
      if (!made.length) return false;
      const doc = await find(tx, setup.documentId);
      await adaptors[doc.adaptor].setup?.(tx, t, doc.config);
      await adaptors[doc.adaptor].init(tx, t, doc, setup.data);
      return true;
    });
  }
  // Trusted setup. Replaces the stored config; existing records must fit it.
  async function configure(documentId: string, config: Config) {
    await database.transaction(async (tx) => {
      const doc = { ...(await find(tx, documentId, true)), config };
      await adaptors[doc.adaptor].setup?.(tx, t, config);
      validate(config, await adaptors[doc.adaptor].read(tx, t, doc));
      await tx.query(`update ${t("documents")} set config = $2 where id = $1`, [
        documentId,
        JSON.stringify(config),
      ]);
    });
  }
  // Trusted setup. Moves a document's records to another adaptor, with their
  // ids, order and stamps, and stores `config` with them when given. The old
  // adaptor's copy is left where it was. False when they are there already.
  async function move(documentId: string, adaptor: string, config?: Config) {
    if (!adaptors[adaptor]) throw refuse(`No ${adaptor} adaptor`);
    return database.transaction(async (tx) => {
      const doc = await find(tx, documentId, true);
      if (doc.adaptor === adaptor) return false;
      const data = await adaptors[doc.adaptor].read(tx, t, doc);
      const moved = { ...doc, adaptor, config: config ?? doc.config };
      validate(moved.config, data);
      await adaptors[adaptor].setup?.(tx, t, moved.config);
      await adaptors[adaptor].init(tx, t, moved, data);
      // Nothing is moved unless it all reads back the same.
      if (!isDeepStrictEqual(await adaptors[adaptor].read(tx, t, moved), data))
        throw Error("The moved records read back differently.");
      await tx.query(
        `update ${t("documents")} set adaptor = $2, config = $3 where id = $1`,
        [documentId, adaptor, JSON.stringify(moved.config)],
      );
      return true;
    });
  }
  // What a page asks for, as JSON over HTTP: a read, a write, or with an
  // `action`, something about signing in. `session` is the token the page
  // holds, from the Authorization header; it alone says who is asking.
  async function act(
    document: string,
    session: string | null,
    body: any,
    origin?: string | null,
  ) {
    // Passkeys belong to the site the page is on, which must be one we serve.
    const here = () => {
      const url = URL.canParse(origin ?? "") ? new URL(origin!) : undefined;
      if (!url || (options.origins && !options.origins.includes(url.origin)))
        throw refuse("Passkeys are not available from here.", 400);
      return { origin: url.origin, rpId: url.hostname };
    };
    const signedIn = () =>
      database.transaction((tx) => auth.caller(tx, document, session));
    switch (body.action) {
      case "exchange":
        return auth.exchange(document, body.token);
      case "whoami":
        return auth.who(document, session);
      case "signout":
        return (await auth.signOut(document, session), {});
      case "passkey-options":
        return auth.passkeyOptions(document, session, here());
      case "passkey-add":
        return auth.addPasskey(document, session, here(), body.response);
      case "passkey-signin-options":
        return auth.passkeySignInOptions(document, here());
      case "passkey-signin":
        return auth.passkeySignIn(document, here(), body.response);
      case "links":
        return { links: await auth.links(document, await signedIn()) };
      case "link-create":
        if (typeof body.person !== "string") throw refuse("Unknown person.");
        return auth.createLink(document, body.person, await signedIn());
      case "link-revoke":
        return (await auth.revokeLink(document, body.id, await signedIn()), {});
      default:
        throw refuse("Not found", 404);
    }
  }
  async function handle(request: {
    method: string;
    document: string | null;
    session?: string | null;
    // Where the page asking is served, for passkeys.
    origin?: string | null;
    body?: any;
  }): Promise<{ status: number; body: unknown }> {
    try {
      const { document, session = null } = request;
      if (!document) throw refuse("Name a document");
      if (request.method === "GET")
        return { status: 200, body: await read(document) };
      if (request.method !== "POST") throw refuse("Not found", 404);
      if (request.body?.action !== undefined)
        return {
          status: 200,
          body: await act(document, session, request.body, request.origin),
        };
      const { requestId, operations } = request.body ?? {};
      if (typeof requestId !== "string") throw refuse("Invalid operations");
      const { person } = await database.transaction((tx) =>
        auth.caller(tx, document, session),
      );
      return {
        status: 200,
        body: await apply(document, requestId, operations, null, { person }),
      };
    } catch (error) {
      const status = (error as { status?: number }).status;
      // A refused value is the caller's mistake; anything else is ours.
      const known =
        status !== undefined ||
        /^(Invalid|Missing|Unknown)/.test((error as Error).message);
      return {
        status: status ?? (known ? 400 : 500),
        body: { message: known ? (error as Error).message : "Could not save." },
      };
    }
  }
  // For Node servers: Vite's dev server, a Vercel function.
  async function node(
    req: AsyncIterable<Uint8Array> & {
      method?: string;
      url?: string;
      headers?: Record<string, string | string[] | undefined>;
    },
    res: {
      statusCode: number;
      setHeader(n: string, v: string): void;
      end(body: string): void;
    },
  ) {
    let body: unknown;
    if (req.method === "POST") {
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of req) {
        chunks.push(chunk);
        if ((size += chunk.length) > 5_000_000) break;
      }
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        body = undefined;
      }
    }
    // A page's origin counts when it is the site this request came to, or
    // one of the `origins` named in the options.
    const header = (name: string) => String(req.headers?.[name] ?? "");
    const origin = header("origin");
    const same =
      URL.canParse(origin) &&
      new URL(origin).host === (header("x-forwarded-host") || header("host"));
    const result = await handle({
      method: req.method ?? "GET",
      origin: options.origins || same ? origin : null,
      document: new URL(req.url ?? "", "http://x").searchParams.get("document"),
      session:
        /^Bearer (\S+)$/.exec(String(req.headers?.authorization ?? ""))?.[1] ??
        null,
      body,
    });
    res.statusCode = result.status;
    res.setHeader("content-type", "application/json");
    res.setHeader("cache-control", "no-store");
    res.end(JSON.stringify(result.body));
  }
  // Trusted setup: a fresh sign-in link for the admin named in the config,
  // as an address on `site`. This is how the admin first gets in.
  async function adminLink(documentId: string, site: string) {
    const link = await auth.createLink(documentId, undefined, {
      trusted: true,
    });
    const url = new URL(site);
    url.searchParams.set("k", link.token);
    return url.href;
  }
  return {
    read,
    apply,
    provision,
    configure,
    move,
    handle,
    node,
    auth,
    adminLink,
  };
}
// A Database on node-postgres: pass `new pg.Pool(...)`.
export function pgDatabase(pool: {
  connect(): Promise<{
    query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
    release(): void;
  }>;
}): Database {
  return {
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const result = await fn({
          query: async (sql, params) => (await client.query(sql, params)).rows,
        });
        await client.query("commit");
        return result;
      } catch (error) {
        await client.query("rollback").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
