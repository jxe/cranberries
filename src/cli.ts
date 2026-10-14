// `cranberries setup` applies the site's database SQL (setup.ts) to
// DATABASE_URL (or POSTGRES_URL or DIRECT_URL), read from the environment or
// .env.local; `cranberries sql`
// prints it, for pasting into the Supabase SQL editor.
//
//   --usl <path>     the document's schema, default lib/schema.usl if it exists
//   --schema <name>  the Postgres schema, default public
//
// Either may instead be given in package.json: "cranberries": { "usl": …,
// "schema": … }. Flags win.
import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { databaseSql, setupDatabase } from "./setup";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { usl: { type: "string" }, schema: { type: "string" } },
});
const [command] = positionals;
if (command !== "setup" && command !== "sql") {
  console.error(
    "Usage: cranberries setup|sql [--usl lib/schema.usl] [--schema public]",
  );
  process.exit(1);
}
const declared = existsSync("package.json")
  ? (JSON.parse(readFileSync("package.json", "utf8")).cranberries ?? {})
  : {};
const path =
  values.usl ??
  declared.usl ??
  (existsSync("lib/schema.usl") ? "lib/schema.usl" : undefined);
const options = {
  schema: values.schema ?? declared.schema ?? "public",
  usl: path ? readFileSync(path, "utf8") : undefined,
};
if (command === "sql") console.log(await databaseSql(options));
else {
  const { DATABASE_URL, POSTGRES_URL, DIRECT_URL } = process.env;
  if (!(DATABASE_URL ?? POSTGRES_URL ?? DIRECT_URL) && existsSync(".env.local"))
    process.loadEnvFile(".env.local");
  await setupDatabase(options);
  console.log(
    `Set up the ${options.schema} schema${path ? `, with the tables of ${path}` : ""}.`,
  );
}
