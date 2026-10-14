// A document's schema, line and views from Ultimate Schema Language
// (https://github.com/jxe/arbor/blob/main/docs/overstory-spec/11-schema-language.md):
// the same `.usl` a Story collection uses becomes the Config this library
// stores and validates.
//
// - Each model with data rows is a collection named after the model in lower
//   case (`@@table("…")` names it instead). It needs a `name Text` field.
// - `Text` is a "text" field and `Markdown` a "longtext" one.
// - `Person` is the "person" collection: a name and a portrait, like a Story
//   profile.
// - A connection to a fixed model is a choice, with its rows' colors. An n:m
//   connection is a relationship stored on its `@fold` end, as data files
//   store it.
// - The collection is the model with `@@views`. Its first view's line is the
//   line; `@bullet`, `@summary` and `@label("…")` in it are presentation, and a
//   view grouped by a connection that is stored on the other side groups by
//   that side's relationship.
// - `@@fixed` models aside, collections can't be added to in the editor when
//   the schema says so with `fixed`.

import { compileUsl, type ResolvedConnection } from "@ovst/usl";
import { defineDocument, type Config, type Field, type GroupBy, type View } from "./model";

export class SchemaError extends Error {
  override name = "SchemaError";
}

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** Compile a `.usl` source to a document config, or throw a {@link SchemaError} listing what's wrong. */
export function documentFromUsl(
  source: string,
  options: { title: string; fixed?: string[] },
): Config {
  const result = compileUsl(source);
  if (result.diagnostics.length > 0) {
    throw new SchemaError(
      result.diagnostics.map((d) => `${d.line}:${d.column}: ${d.code}: ${d.message}`).join("\n"),
    );
  }
  const models = new Map(result.models.map((m) => [m.name, m]));
  const fixedModel = (name: string) => models.get(name)?.rows === "fixed";
  const key = (name: string) =>
    name === "Person" ? "person" : (models.get(name)!.table ?? lowerFirst(name));
  const usesPerson = result.connections.some((c) => c.a.model === "Person" || c.b.model === "Person");

  const data = result.models.filter((m) => m.rows !== "fixed" && m.name !== "Person");
  for (const model of data) {
    if (model.ends.length > 0) throw new SchemaError(`${model.name}: connection models aren't supported; connect the two models directly`);
    if (model.rows === "seed") throw new SchemaError(`${model.name}: @@seed isn't supported; use @@fixed`);
  }
  const withViews = data.filter((m) => m.views.length > 0);
  if (withViews.length !== 1) throw new SchemaError("Give exactly one model @@views: the document's collection");
  const main = withViews[0]!;
  const line = main.views[0]!.line;
  if (line.length === 0) throw new SchemaError(`${main.name}: its first view needs a line`);
  const presentation = new Map(line.map((item) => [item.field, item]));

  const schema: Config["schema"] = {};
  if (usesPerson) schema.person = { name: "text", portrait: "text" };
  for (const model of data) {
    const fields: Record<string, Field> = {};
    for (const field of model.fields) {
      if (field.origin !== "declared") continue;
      if (field.type === "Text" && field.arity === "one") fields[field.name] = "text";
      else if (field.type === "Markdown") fields[field.name] = "longtext";
      else if (!models.has(field.type) && field.type !== "Person") {
        throw new SchemaError(`${model.name}.${field.name}: cranberries stores Text and Markdown values only`);
      }
    }
    if (fields.name !== "text") throw new SchemaError(`${model.name} needs a \`name Text\` field`);
    schema[key(model.name)] = fields;
  }

  // Where each connection lives in the document, so views can group by it.
  const stored = new Map<string, { collection: string; field: string }>();
  for (const connection of result.connections) {
    const { a, b } = connection;
    if (fixedModel(a.model) || fixedModel(b.model)) {
      const [holder, choice] = fixedModel(b.model) ? [a, b] : [b, a];
      if (holder.arity !== "one") throw new SchemaError(`${holder.model}.${holder.field}: a choice holds exactly one value`);
      const rows = models.get(choice.model)!.schemaRows;
      const colors = Object.fromEntries(rows.flatMap((r) => (r.color ? [[r.name, r.color]] : [])));
      schema[key(holder.model)]![holder.field] = {
        choices: rows.map((r) => r.name),
        ...(Object.keys(colors).length ? { colors } : {}),
        ...(holder.model === main.name && presentation.get(holder.field)?.bullet ? { bullet: true } : {}),
      };
      continue;
    }
    const holder = storedEnd(connection);
    const other = holder === a ? b : a;
    if (holder.model === "Person") throw new SchemaError(`${connection.ends.join(" <-> ")}: fold the other end; people are provisioned`);
    const item = holder.model === main.name ? presentation.get(holder.field) : undefined;
    schema[key(holder.model)]![holder.field] = {
      many: key(other.model),
      ...(item?.label ? { label: item.label } : {}),
      ...(item?.summary ? { summary: true } : {}),
    };
    stored.set(`${a.model}.${a.field}`, { collection: key(holder.model), field: holder.field });
    stored.set(`${b.model}.${b.field}`, { collection: key(holder.model), field: holder.field });
  }

  const views: View[] = main.views.map((view) => {
    if (!view.group) return { label: view.label };
    const where = stored.get(`${main.name}.${view.group}`);
    const groupBy: GroupBy = !where || where.collection === key(main.name) ? view.group : where;
    return { label: view.label, groupBy };
  });

  // A collection's noun is the label its members get in the line, else its own name.
  const labels: Record<string, string> = {};
  for (const model of [...data.map((m) => m.name), ...(usesPerson ? ["Person"] : [])]) labels[key(model)] = lowerFirst(model);
  for (const item of line) {
    const field = schema[key(main.name)]![item.field];
    if (item.label && typeof field === "object" && "many" in field) labels[field.many] = item.label;
  }

  return defineDocument({
    title: options.title,
    schema,
    collection: key(main.name),
    line: line.map((item) => item.field),
    views,
    labels,
    ...(options.fixed ? { fixed: options.fixed } : {}),
  });
}

/** The end whose rows hold an n:m connection: the `@fold` end. */
function storedEnd(connection: ResolvedConnection) {
  const { a, b } = connection;
  if (a.arity !== "many" || b.arity !== "many") {
    throw new SchemaError(`${connection.ends.join(" <-> ")}: cranberries stores many-to-many connections only`);
  }
  if (a.fold) return a;
  if (b.fold) return b;
  throw new SchemaError(`${connection.ends.join(" <-> ")}: mark the end that holds it with @fold`);
}

