// Setting up a site's database, run with Node and a database URL, never in a
// browser: the library's tables and their access rules (sql/schema.sql), and
// the tables of the site's .usl document. All of it creates only what is
// missing, so it is safe to run again. `cranberries setup` runs it; see cli.ts.
import { readFile } from "node:fs/promises";
import { tablesSql } from "./usl";
import { createServer, pgDatabase, type ServerOptions } from "./server";
import type { Config, Data } from "./model";

export type SetupOptions = {
  // The Postgres schema the library's and the document's tables go in.
  schema?: string;
  // The .usl source of the site's document, whose tables are made too.
  usl?: string;
};

// The library's SQL in `schema`, then the document's tables.
export async function databaseSql({
  schema = "public",
  usl,
}: SetupOptions = {}): Promise<string> {
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw Error("Invalid schema name.");
  const library = (
    await readFile(new URL("../sql/schema.sql", import.meta.url), "utf8")
  )
    .replaceAll("public.", `${schema}.`)
    .replaceAll("schemaname='public'", `schemaname='${schema}'`)
    .replaceAll("nspname='public'", `nspname='${schema}'`);
  return [
    ...(schema === "public"
      ? []
      : [
          `create schema if not exists ${schema};\n` +
            `grant usage on schema ${schema} to anon, authenticated, service_role;`,
        ]),
    library.trimEnd(),
    ...(usl
      ? [
          "-- The document's records, in the tables its .usl lays out.",
          tablesSql(usl, schema),
        ]
      : []),
  ].join("\n\n");
}

const pool = async (url = process.env.DATABASE_URL) => {
  if (!url) throw Error("Set DATABASE_URL first.");
  const { default: pg } = await import("pg");
  return new pg.Pool({ connectionString: url, max: 1 });
};

// Applies databaseSql in one transaction to the database at `url`.
export async function setupDatabase(
  options: SetupOptions & { url?: string } = {},
) {
  const sql = await databaseSql(options);
  const db = await pool(options.url);
  try {
    await pgDatabase(db).transaction((tx) => tx.query(sql));
  } finally {
    await db.end();
  }
}

// For a seed script: sets up the database, then creates the document if it
// is missing, and otherwise brings its stored config up to date with the one
// in code, leaving its records alone. Uses DATABASE_URL.
export async function seedFromEnv(
  options: {
    documentId: string;
    config: Config;
    data: Data;
    publicRead?: boolean;
    publicWrite?: boolean;
    adaptor?: string;
  } & Pick<ServerOptions, "schema">,
) {
  await setupDatabase({ schema: options.schema, usl: options.config.usl });
  const db = await pool();
  try {
    const server = createServer({
      database: pgDatabase(db),
      schema: options.schema,
    });
    const made = await server.provision(options);
    await server.configure(options.documentId, options.config);
    return made;
  } finally {
    await db.end();
  }
}
