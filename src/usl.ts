// A document's collections, line and views from Ultimate Schema Language
// (https://github.com/jxe/arbor/blob/main/docs/overstory-spec/11-schema-language.md):
// the same `.usl` a Story collection uses becomes the Config this library
// stores and validates.
//
// - Each model with data rows is a collection named after the model in lower
//   case (`@table("…")` names it instead). It needs a `name Text` field.
// - `Text` is a "text" field and `Markdown` a "longtext" one.
// - `Person` is the "person" collection: people with a name, short name and
//   image, like Story profiles.
// - A connection to an `enum` is a choice, with the colors its `re` block
//   gives its values (`~color`). An n:m connection is a relationship stored
//   on its `@fold` end, as data files store it.
// - The main collection is the `main model`. The first of its `~views` gives
//   the line; `~bullet` and `~summary` in it are presentation, and
//   `~label("…")` names the collection its members belong to. A view grouped
//   by a connection that is stored on the other side groups by that side's
//   relationship; `sort: modified` puts recent changes first.
// - The records are kept in the tables USL lays out for a database (`tablesSql`
//   makes them): a table per collection, keyed by `id`, and a join table per
//   relationship. The config keeps the source as `usl`, so the server knows
//   the tables from it (`storageOf`); people, who have no table there, the
//   library keeps in dv_people.
// - What the language doesn't say (who the admin is, the search box, which
//   collections are provisioned rather than added to in the editor, and who
//   owns a collection's records) is given as options. Ownership is access
//   policy, not schema: `owners: { game: "authors" }` makes a game editable
//   only by the people in its `authors` field.

import {
  compileUsl,
  layoutOf,
  setupSql,
  type CheckResult,
  type ResolvedConnection,
  type Table,
} from "@ovst/usl";
import {
  defineDocument,
  type Collection,
  type Config,
  type Field,
  type GroupBy,
  type View,
} from "./model";

export class SchemaError extends Error {
  override name = "SchemaError";
}

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** Compile a `.usl` source to a document config, or throw a {@link SchemaError} listing what's wrong. */
export function documentFromUsl(
  source: string,
  options: {
    title: string;
    fixed?: string[];
    admin?: string;
    search?: boolean;
    /** Collection key to the person field whose people own its records. */
    owners?: Record<string, string>;
  },
): Config {
  const result = compiled(source);
  const models = new Map(result.models.map((m) => [m.name, m]));
  const fixedModel = (name: string) => models.get(name)?.rows === "fixed";
  const key = (name: string) =>
    name === "Person"
      ? "person"
      : (models.get(name)!.table ?? lowerFirst(name));
  const usesPerson = result.connections.some(
    (c) => c.a.model === "Person" || c.b.model === "Person",
  );

  const data = result.models.filter(
    (m) => m.rows !== "fixed" && m.name !== "Person",
  );
  for (const model of data) {
    if (model.ends.length > 0)
      throw new SchemaError(
        `${model.name}: connection models aren't supported; connect the two models directly`,
      );
    if (model.rows === "seed")
      throw new SchemaError(
        `${model.name}: seed rows aren't supported; use an enum`,
      );
    if (model.key.join() !== "id")
      throw new SchemaError(`${model.name}: records are keyed by id only`);
  }
  const main = data.find((m) => m.main);
  if (!main)
    throw new SchemaError(
      "Mark the document's main collection `main model`",
    );
  const line = main.views[0]?.line ?? [];
  if (line.length === 0)
    throw new SchemaError(`${main.name}: give it ~views, the first with a line`);
  const presentation = new Map(line.map((item) => [item.field, item]));

  // The field each end of a connection becomes on the model that stores it.
  const stored = new Map<string, { collection: string; field: string }>();
  const connected = new Map<string, Field>();
  for (const connection of result.connections) {
    const { a, b } = connection;
    if (fixedModel(a.model) || fixedModel(b.model)) {
      const [holder, choice] = fixedModel(b.model) ? [a, b] : [b, a];
      if (holder.arity !== "one")
        throw new SchemaError(
          `${holder.model}.${holder.field}: a choice holds exactly one value`,
        );
      const rows = models.get(choice.model)!.schemaRows;
      connected.set(`${holder.model}.${holder.field}`, {
        type: "choice",
        options: rows.map((r) =>
          r.color ? { name: r.name, color: r.color } : { name: r.name },
        ),
        ...(holder.model === main.name && presentation.get(holder.field)?.bullet
          ? { bullet: true }
          : {}),
      });
      continue;
    }
    const holder = storedEnd(connection);
    const other = holder === a ? b : a;
    if (holder.model === "Person")
      throw new SchemaError(
        `${connection.ends.join(" <-> ")}: fold the other end; people are provisioned`,
      );
    const item =
      holder.model === main.name ? presentation.get(holder.field) : undefined;
    connected.set(`${holder.model}.${holder.field}`, {
      type: "many",
      of: key(other.model),
      ...(item?.summary ? { summary: true } : {}),
    });
    stored.set(`${a.model}.${a.field}`, {
      collection: key(holder.model),
      field: holder.field,
    });
    stored.set(`${b.model}.${b.field}`, {
      collection: key(holder.model),
      field: holder.field,
    });
  }

  // A collection's noun is the label its members get in the line, else its own name.
  const labels = new Map<string, string>();
  for (const item of line) {
    const field = connected.get(`${main.name}.${item.field}`);
    if (item.label && field?.type === "many") labels.set(field.of, item.label);
  }
  const fixed = new Set(options.fixed ?? []);
  const collection = (
    name: string,
    fields: Record<string, Field>,
  ): Collection => {
    const k = key(name);
    const owner = options.owners?.[k];
    const held = owner === undefined ? undefined : fields[owner];
    if (owner !== undefined && !(held?.type === "many" && held.of === "person"))
      throw new SchemaError(`owners: ${k}.${owner} isn't a field of people`);
    return {
      ...(name === "Person" ? { kind: "person" as const } : {}),
      label: labels.get(k) ?? lowerFirst(name),
      ...(fixed.has(k) ? { fixed: true } : {}),
      ...(owner !== undefined ? { owners: owner } : {}),
      fields,
    };
  };

  const collections: Record<string, Collection> = {};
  if (usesPerson) collections.person = collection("Person", {});
  for (const model of data) {
    const fields: Record<string, Field> = {};
    // The checker keeps fields in the order they're written.
    for (const field of model.fields) {
      const link = connected.get(`${model.name}.${field.name}`);
      if (link) fields[field.name] = link;
      else if (field.origin !== "declared") continue;
      else if (field.type === "Text" && field.arity !== "many")
        fields[field.name] = { type: "text" };
      else if (field.type === "Markdown")
        fields[field.name] = { type: "longtext" };
      else if (!models.has(field.type) && field.type !== "Person") {
        throw new SchemaError(
          `${model.name}.${field.name}: cranberries stores Text and Markdown values only`,
        );
      }
    }
    if (fields.name?.type !== "text")
      throw new SchemaError(`${model.name} needs a \`name Text\` field`);
    collections[key(model.name)] = collection(model.name, fields);
  }
  for (const k of Object.keys(options.owners ?? {}))
    if (!collections[k] || k === "person")
      throw new SchemaError(`owners: no collection ${k}`);

  const views: View[] = main.views.map((view) => {
    if (view.sort && view.sort !== "modified")
      throw new SchemaError(
        `${view.label}: cranberries sorts by modified only`,
      );
    const where = view.group
      ? stored.get(`${main.name}.${view.group}`)
      : undefined;
    const groupBy: GroupBy | undefined =
      view.group &&
      (!where || where.collection === key(main.name) ? view.group : where);
    return {
      label: view.label,
      ...(groupBy ? { groupBy } : {}),
      ...(view.sort ? { sort: "modified" as const } : {}),
    };
  });

  return defineDocument({
    title: options.title,
    collections,
    main: key(main.name),
    line: line.map((item) => item.field),
    views,
    ...(options.search ? { search: true } : {}),
    ...(options.admin ? { admin: options.admin } : {}),
    usl: source,
  });
}

// The tables of a document built from USL, and the model each collection is.
export type UslStorage = { tables: Table[]; models: Record<string, string> };
const storages = new Map<string, UslStorage>();
/** Where a USL document's records are kept, from the source in its config. */
export function storageOf(config: Config): UslStorage {
  if (!config.usl) throw Error("The config has no USL schema.");
  let storage = storages.get(config.usl);
  if (!storage) {
    const result = compiled(config.usl);
    const tables = layoutOf(result, { store: "database" });
    const models = Object.fromEntries(
      result.models
        .filter((m) => m.rows !== "fixed" && m.name !== "Person")
        .map((m) => [m.table ?? lowerFirst(m.name), m.name]),
    );
    storages.set(config.usl, (storage = { tables, models }));
  }
  return storage;
}

/**
 * Setup SQL for the tables a `.usl` document's records are kept in, in
 * `schema`. Like the library's own schema.sql, it creates only what is
 * missing, so it is safe to run again; only the server function reads or
 * writes the tables.
 */
export function tablesSql(source: string, schema = "public"): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw Error("Invalid schema name.");
  const tables = layoutOf(compiled(source), { store: "database" });
  const name = (table: Table) =>
    `${schema}."${table.name.replaceAll('"', '""')}"`;
  return [
    setupSql(tables, "postgres", { schema }).trimEnd(),
    ...tables.map(
      (table) =>
        `alter table ${name(table)} enable row level security;\n` +
        `revoke all on ${name(table)} from anon, authenticated;\n` +
        `grant all on ${name(table)} to service_role;`,
    ),
  ].join("\n\n");
}

function compiled(source: string): CheckResult {
  const result = compileUsl(source);
  if (result.diagnostics.length > 0) {
    throw new SchemaError(
      result.diagnostics
        .map((d) => `${d.line}:${d.column}: ${d.code}: ${d.message}`)
        .join("\n"),
    );
  }
  return result;
}

/** The end whose rows hold an n:m connection: the `@fold` end. */
function storedEnd(connection: ResolvedConnection) {
  const { a, b } = connection;
  if (a.arity !== "many" || b.arity !== "many") {
    throw new SchemaError(
      `${connection.ends.join(" <-> ")}: cranberries stores many-to-many connections only`,
    );
  }
  if (a.fold) return a;
  if (b.fold) return b;
  throw new SchemaError(
    `${connection.ends.join(" <-> ")}: mark the end that holds it with @fold`,
  );
}
