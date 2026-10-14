// A document's collections, line and views from Ultimate Schema Language
// (https://github.com/jxe/arbor/blob/main/docs/overstory-spec/11-schema-language.md):
// the same `.usl` a Story collection uses becomes the Config this library
// stores and validates.
//
// - Each model with data rows is a collection named after the model in lower
//   case (`@@table("…")` names it instead). It needs a `name Text` field.
// - `Text` is a "text" field and `Markdown` a "longtext" one.
// - `Person` is the "person" collection: people with a name, short name and
//   image, like Story profiles.
// - A connection to a fixed model is a choice, with its rows' colors. An n:m
//   connection is a relationship stored on its `@fold` end, as data files
//   store it.
// - `@@editableBy(field)` makes a collection owned by the people in that field.
// - The main collection is the model with `@@views`. Its first view's line is
//   the line; `@bullet` and `@summary` in it are presentation, and
//   `@label("…")` names the collection its members belong to. A view grouped
//   by a connection that is stored on the other side groups by that side's
//   relationship; `sort: modified` puts recent changes first.
// - The records are kept in the tables USL lays out for a database (`tablesSql`
//   makes them): a table per collection, keyed by `id`, and a join table per
//   relationship. The config's `storage` says which is which; people, who
//   have no table there, the library keeps in dv_people.
// - What the language doesn't say (who the admin is, the search box, which
//   collections are provisioned rather than added to in the editor) is given
//   as options.

import {
  compileUsl,
  layoutOf,
  parseUsl,
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
  type Storage,
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
  },
): Config {
  const result = compiled(source);
  const layout = layoutOf(result, { store: "database" });
  const tableOf = (stores: string) =>
    layout.find((table) => table.stores === stores)!;
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
        `${model.name}: @@seed isn't supported; use @@fixed`,
      );
    if (model.key.join() !== "id")
      throw new SchemaError(`${model.name}: records are keyed by id only`);
  }
  const withViews = data.filter((m) => m.views.length > 0);
  if (withViews.length !== 1)
    throw new SchemaError(
      "Give exactly one model @@views: the document's main collection",
    );
  const main = withViews[0]!;
  const line = main.views[0]!.line;
  if (line.length === 0)
    throw new SchemaError(`${main.name}: its first view needs a line`);
  const presentation = new Map(line.map((item) => [item.field, item]));

  // The field each end of a connection becomes on the model that stores it.
  const stored = new Map<string, { collection: string; field: string }>();
  const connected = new Map<string, Field>();
  const joins = new Map<string, Storage[string]["joins"][string]>();
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
    const table = tableOf(`${a.model}.${a.field}`);
    const [first, second] = table.columns.map((c) => c.name);
    joins.set(`${holder.model}.${holder.field}`, {
      table: table.name,
      from: holder === a ? first! : second!,
      to: holder === a ? second! : first!,
      ...(holder.ordered ? { position: `${holder.field}_position` } : {}),
      ...(other.ordered ? { back: `${other.field}_position` } : {}),
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
  const { owners, order } = declared(source);
  const fixed = new Set(options.fixed ?? []);
  const collection = (
    name: string,
    fields: Record<string, Field>,
  ): Collection => {
    const k = key(name);
    const owner = owners.get(name);
    if (owner && owner.length > 1)
      throw new SchemaError(`${name}: @@editableBy takes one field`);
    return {
      ...(name === "Person" ? { kind: "person" as const } : {}),
      label: labels.get(k) ?? lowerFirst(name),
      ...(fixed.has(k) ? { fixed: true } : {}),
      ...(owner ? { owners: owner[0] } : {}),
      fields,
    };
  };

  const collections: Record<string, Collection> = {};
  const storage: Storage = {};
  if (usesPerson) collections.person = collection("Person", {});
  for (const model of data) {
    const fields: Record<string, Field> = {};
    const written = order.get(model.name) ?? [];
    const place = (name: string) =>
      written.includes(name) ? written.indexOf(name) : written.length;
    for (const field of [...model.fields].sort(
      (x, y) => place(x.name) - place(y.name),
    )) {
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
    const column = (name: string) =>
      model.fields.find((f) => f.name === name)?.column ?? name;
    storage[key(model.name)] = {
      table: tableOf(model.name).name,
      columns: Object.fromEntries(
        Object.entries(fields).flatMap(([name, f]) =>
          f.type === "many" ? [] : [[name, column(name)]],
        ),
      ),
      joins: Object.fromEntries(
        Object.entries(fields).flatMap(([name, f]) =>
          f.type === "many"
            ? [[name, joins.get(`${model.name}.${name}`)!]]
            : [],
        ),
      ),
    };
  }

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
    storage,
  });
}

/**
 * Setup SQL for the tables a `.usl` document's records are kept in, in
 * `schema`. Like the library's own schema.sql, it creates only what is
 * missing, so it is safe to run again; only the server function reads or
 * writes the tables.
 */
export function tablesSql(source: string, schema = "public"): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw Error("Invalid schema name.");
  const tables: Table[] = layoutOf(compiled(source), { store: "database" });
  const name = (table: Table) =>
    `${schema}."${table.name.replaceAll('"', '""')}"`;
  return [
    `set search_path to ${schema};`,
    setupSql(tables, "postgres").trimEnd(),
    ...tables.map(
      (table) =>
        `alter table ${name(table)} enable row level security;\n` +
        `revoke all on ${name(table)} from anon, authenticated;\n` +
        `grant all on ${name(table)} to service_role;`,
    ),
    "reset search_path;",
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

/**
 * Each model's `@@editableBy` fields, which the checker validates but doesn't
 * resolve, and its fields in the order they're written, which it doesn't keep.
 */
function declared(source: string) {
  const owners = new Map<string, string[]>();
  const order = new Map<string, string[]>();
  for (const declaration of parseUsl(source).file?.declarations ?? []) {
    if (declaration.kind !== "model") continue;
    order.set(
      declaration.name,
      declaration.members.flatMap((m) => (m.kind === "field" ? [m.name] : [])),
    );
    for (const member of declaration.members) {
      if (member.kind !== "modelAttribute" || member.name !== "editableBy")
        continue;
      owners.set(
        declaration.name,
        member.args.flatMap((arg) => (arg.kind === "ident" ? [arg.name] : [])),
      );
    }
  }
  return { owners, order };
}
