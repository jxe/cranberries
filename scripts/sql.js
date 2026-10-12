// Prints the database SQL for installing into a schema other than `public`,
// which keeps the library's tables apart from an existing application's:
// `npm run sql -- remake schema | psql ...` prints the whole schema, safe to run
// on an empty database or again later. `npm run sql -- remake 004` prints the
// migrations from 004 on, for upgrading an older install. Afterwards, add the
// schema to the project's exposed schemas (Supabase: API settings) and pass
// `schema` to the library.
import { readdirSync, readFileSync } from "node:fs";
const [schema = "public", from = "001"] = process.argv.slice(2);
if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw Error("Invalid schema name.");
const dir = new URL("../sql/", import.meta.url);
const files =
  from === "schema"
    ? ["schema.sql"]
    : readdirSync(dir)
        .filter((f) => /^\d/.test(f) && f.slice(0, 3) >= from)
        .sort();
if (schema !== "public" && (from === "001" || from === "schema"))
  console.log(
    `create schema if not exists ${schema};\n` +
      `grant usage on schema ${schema} to anon, authenticated, service_role;`,
  );
for (const file of files)
  console.log(
    readFileSync(new URL(file, dir), "utf8")
      .replaceAll("public.", `${schema}.`)
      .replaceAll("schemaname='public'", `schemaname='${schema}'`),
  );
