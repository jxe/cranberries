// Prints the migrations, in order, for installing into a schema other than
// `public`: `npm run sql -- remake | psql ...`. The schema keeps the library's
// tables apart from an existing application's. Afterwards, add the schema to the
// project's exposed schemas (Supabase: API settings) and pass `schema` to the
// library. Pass a second argument to start from a later migration, e.g. 003.
import { readdirSync, readFileSync } from "node:fs";
const [schema = "public", from = "001"] = process.argv.slice(2);
if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw Error("Invalid schema name.");
const dir = new URL("../sql/", import.meta.url);
const files = readdirSync(dir)
  .filter((f) => f.endsWith(".sql") && f.slice(0, 3) >= from)
  .sort();
if (schema !== "public" && from === "001")
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
