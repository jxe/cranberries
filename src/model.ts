export type Value = string | string[];
// `modified` is stamped by the database when a write to the record lands.
export type Entity = { id: string; modified?: string } & {
  [field: string]: Value;
};
export type Data = Record<string, Entity[]>;
// "text" is a single required line; "longtext" may be empty, span lines and
// use light markdown (see markdown.ts).
export const limits = { text: 10000, longtext: 100000 };
export type Option = { name: string; color?: string };
// Every field is one object with a `type`. `default` fills a field that an
// existing record lacks, so a field can be added without rewriting the data.
export type Field =
  | { type: "text" | "longtext"; default?: string }
  | { type: "choice"; options: Option[]; bullet?: boolean; default?: string }
  | { type: "many"; of: string; label?: string; summary?: boolean };
// A collection holds everything about itself. `fixed` members are provisioned,
// not added or renamed in the editor. A "person" also has `short` and `image`.
export type Collection = {
  kind?: "person";
  label?: string;
  fixed?: boolean;
  fields: Record<string, Field>;
};
export type Config = {
  title: string;
  collections: Record<string, Collection>;
  // The collection whose records are the lines.
  main: string;
  line: string[];
  views: View[];
  // Show a box that filters lines by their text and related names.
  search?: boolean;
};
// Group by a field of the main collection, by another collection's relationship
// to it (rows keep that relationship's order), or omit groupBy for a flat view.
export type GroupBy = string | { collection: string; field: string };
// sort: "modified" puts the most recently changed first: rows in a flat or
// field-grouped view, groups in a relationship view (whose rows keep its order).
export type View = { label: string; groupBy?: GroupBy; sort?: "modified" };
export type Snapshot = { data: Data; revision: number };
// link and unlink change one member of a relationship, so two people changing
// different members of the same one do not conflict.
export type Operation =
  | {
      kind: "set";
      type: string;
      id: string;
      field: string;
      before: Value;
      value: Value;
    }
  | {
      kind: "link" | "unlink";
      type: string;
      id: string;
      field: string;
      value: string;
    }
  | { kind: "create"; type: string; id: string; value: Entity }
  | { kind: "delete"; type: string; id: string; before: Entity };
// One committed write, as the change log records it and pages receive it.
export type Change = { revision: number; at: string; operations: Operation[] };
export const equal = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
// What defineDocument accepts: the stored shape, with "text" and "longtext" as
// shorthand, and builders (see builder.ts) wherever they turn into that shape.
type Builds<T> = { toJSON(): T };
export type FieldInput = Field | "text" | "longtext";
export type CollectionInput =
  | (Omit<Collection, "fields"> & { fields?: Record<string, FieldInput> })
  | Builds<Collection>;
export type ConfigInput = Omit<Config, "collections" | "main"> & {
  collections:
    Record<string, CollectionInput> | (Builds<Collection> & { key: string })[];
  main: string | { key: string };
};
const personFields: Record<string, Field> = {
  name: { type: "text" },
  short: { type: "text" },
  image: { type: "text" },
};
export const fieldsOf = (config: Config, type: string) =>
  config.collections[type].fields;
export const labelOf = (config: Config, type: string) =>
  config.collections[type]?.label ?? type;
export function defineDocument(input: ConfigInput): Config {
  const main = typeof input.main === "string" ? input.main : input.main.key;
  const plain = (c: CollectionInput) => ("toJSON" in c ? c.toJSON() : c);
  const config: Config = {
    title: input.title,
    collections: Object.fromEntries(
      (Array.isArray(input.collections)
        ? input.collections.map((c) => [c.key, plain(c)] as const)
        : Object.entries(input.collections).map(
            ([key, c]) => [key, plain(c)] as const,
          )
      ).map(([key, c]) => [
        key,
        {
          ...c,
          fields: Object.fromEntries(
            Object.entries({
              ...(c.kind === "person" ? personFields : {}),
              ...c.fields,
            }).map(([name, f]) => [
              name,
              typeof f === "string" ? { type: f } : { ...f },
            ]),
          ),
        },
      ]),
    ),
    main,
    line: input.line,
    // A relationship of the main collection is grouped by as its own field.
    views: input.views.map((view) =>
      typeof view.groupBy === "object" && view.groupBy.collection === main
        ? { ...view, groupBy: view.groupBy.field }
        : view,
    ),
    ...(input.search ? { search: true } : {}),
  };
  const fields = config.collections[main]?.fields;
  if (!fields || !config.views.length || !config.line.length)
    throw Error("A main collection, line, and views are required.");
  for (const collection of Object.values(config.collections)) {
    const own = collection.fields;
    if (own.name?.type !== "text" || "id" in own || "modified" in own)
      throw Error(
        "Each collection needs a text name; id and modified are reserved.",
      );
    for (const field of Object.values(own)) {
      if (field.type === "many" && !config.collections[field.of])
        throw Error("Unknown relationship collection.");
      if (
        field.type === "choice" &&
        (!field.options.length ||
          (field.default !== undefined &&
            !field.options.some((o) => o.name === field.default)))
      )
        throw Error("A choice needs options, and its default must be one.");
    }
  }
  for (const field of config.line)
    if (!fields[field]) throw Error(`Unknown line field: ${field}`);
  for (const view of config.views) {
    if (view.groupBy === undefined) continue;
    if (typeof view.groupBy === "object") {
      const d =
        config.collections[view.groupBy.collection]?.fields[view.groupBy.field];
      if (d?.type !== "many" || d.of !== main)
        throw Error("Group by a relationship to the main collection.");
    } else if (!["many", "choice"].includes(fields[view.groupBy]?.type))
      throw Error("Group by a relationship or choice.");
  }
  return config;
}
export type Group = {
  id: string;
  name: string;
  type: string | null;
  rows: Entity[];
};
export function groups(config: Config, data: Data, field?: GroupBy): Group[] {
  const all = data[config.main] ?? [];
  if (field === undefined) return [{ id: "", name: "", type: null, rows: all }];
  if (typeof field === "object") {
    const seen = new Set<string>();
    const result = (data[field.collection] ?? []).map((owner) => ({
      id: owner.id,
      name: String(owner.name),
      type: field.collection,
      rows: (owner[field.field] as string[]).flatMap((id) => {
        const row = all.find((r) => r.id === id);
        if (row) seen.add(id);
        return row ? [row] : [];
      }),
    }));
    const rest = all.filter((r) => !seen.has(r.id));
    return [
      ...result,
      ...(rest.length
        ? [{ id: "", name: "Unassigned", type: null, rows: rest }]
        : []),
    ];
  }
  const descriptor = fieldsOf(config, config.main)[field];
  if (descriptor.type !== "many" && descriptor.type !== "choice") return [];
  const candidates =
    descriptor.type === "many"
      ? (data[descriptor.of] ?? []).map((r) => ({
          id: r.id,
          name: String(r.name),
          type: descriptor.of as string | null,
        }))
      : descriptor.options.map(({ name }) => ({ id: name, name, type: null }));
  const rows = all;
  const result = candidates.map((group) => ({
    ...group,
    rows: rows.filter((r) =>
      Array.isArray(r[field])
        ? r[field].includes(group.id)
        : r[field] === group.id,
    ),
  }));
  const known = new Set(candidates.map((g) => g.id));
  const unassigned = rows.filter((r) =>
    Array.isArray(r[field])
      ? !r[field].some((id) => known.has(id))
      : !known.has(r[field]),
  );
  return [
    ...result,
    ...(unassigned.length
      ? [{ id: "", name: "Unassigned", type: null, rows: unassigned }]
      : []),
  ];
}
// Newest first by `stamp`; records without one keep their place at the end.
export function sortGroups(
  view: View,
  list: Group[],
  stamp: (type: string, id: string) => string | undefined,
  collection: string,
): Group[] {
  if (view.sort !== "modified") return list;
  const newest = <T>(items: T[], of: (item: T) => string | undefined) =>
    items
      .map((item, i) => ({ item, i, at: of(item) ?? "" }))
      .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.i - b.i))
      .map((x) => x.item);
  if (typeof view.groupBy === "object")
    return newest(list, (g) => (g.type ? stamp(g.type, g.id) : undefined));
  return list.map((g) => ({
    ...g,
    rows: newest(g.rows, (r) => stamp(collection, r.id)),
  }));
}
// Keep the rows whose text, choices or related names contain every word of the
// query. A group whose own name matches keeps all its rows; emptied groups go.
export function search(
  config: Config,
  data: Data,
  list: Group[],
  query: string,
): Group[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return list;
  const haystack = (row: Entity) =>
    Object.entries(fieldsOf(config, config.main))
      .map(([name, d]) =>
        d.type === "many"
          ? (row[name] as string[])
              .map((id) => data[d.of]?.find((r) => r.id === id)?.name ?? "")
              .join(" ")
          : String(row[name]),
      )
      .join("\n")
      .toLowerCase();
  const has = (text: string) => words.every((w) => text.includes(w));
  return list
    .map((g) =>
      g.id && has(g.name.toLowerCase())
        ? g
        : { ...g, rows: g.rows.filter((r) => has(haystack(r))) },
    )
    .filter((g) => g.rows.length);
}
export function newEntity(config: Config, type: string, id: string): Entity {
  return Object.fromEntries([
    ["id", id],
    ...Object.entries(fieldsOf(config, type)).map(([name, field]) => [
      name,
      field.type === "many"
        ? []
        : (field.default ??
          (field.type === "choice"
            ? field.options[0].name
            : name === "name"
              ? `New ${labelOf(config, type)}`
              : "")),
    ]),
  ]) as Entity;
}
// Entity deletion also removes memberships; occurrence removal is a relationship edit.
// `at` stamps the written record, as the database does. The client's overlay of
// unsaved operations leaves it out, so stamps only ever come from a commit.
export function apply(
  config: Config,
  data: Data,
  op: Operation,
  at?: string,
): Data {
  const stamp = at ? { modified: at } : {};
  if (op.kind === "create")
    return {
      ...data,
      [op.type]: [
        ...(data[op.type] ?? []).filter((r) => r.id !== op.id),
        { ...op.value, ...stamp },
      ],
    };
  if (op.kind !== "delete") {
    const next = (r: Entity): Value => {
      if (op.kind === "set") return op.value;
      const members = (r[op.field] as string[]).filter((m) => m !== op.value);
      return op.kind === "link" ? [...members, op.value] : members;
    };
    return {
      ...data,
      [op.type]: (data[op.type] ?? []).map((r) =>
        r.id !== op.id ||
        (op.kind === "link" && (r[op.field] as string[]).includes(op.value))
          ? r
          : { ...r, [op.field]: next(r), ...stamp },
      ),
    };
  }
  const result: Data = {};
  for (const [type, rows] of Object.entries(data))
    result[type] = rows
      .filter((r) => type !== op.type || r.id !== op.id)
      .map((r) => {
        const next = { ...r };
        for (const [field, d] of Object.entries(
          config.collections[type]?.fields ?? {},
        ))
          if (d.type === "many" && d.of === op.type)
            next[field] = (r[field] as string[]).filter((id) => id !== op.id);
        return next;
      });
  return result;
}
export function validate(config: Config, data: Data) {
  for (const [type, { fields }] of Object.entries(config.collections)) {
    if (!Array.isArray(data[type])) throw Error(`Missing collection ${type}`);
    const ids = new Set<string>();
    for (const row of data[type]) {
      if (!row.id || ids.has(row.id))
        throw Error("Missing or duplicate entity ID.");
      ids.add(row.id);
      if (
        Object.keys(row).some(
          (k) => k !== "id" && k !== "modified" && !(k in fields),
        )
      )
        throw Error("Unknown field.");
      if (row.modified !== undefined && typeof row.modified !== "string")
        throw Error("Invalid modified time.");
      for (const [field, d] of Object.entries(fields)) {
        const v = row[field];
        if (d.type === "choice") {
          if (typeof v !== "string" || !d.options.some((o) => o.name === v))
            throw Error("Invalid choice.");
        } else if (d.type !== "many") {
          if (typeof v !== "string" || v.length > limits[d.type])
            throw Error("Invalid text.");
        } else if (
          !Array.isArray(v) ||
          new Set(v).size !== v.length ||
          v.some((id) => !(data[d.of] ?? []).some((r) => r.id === id))
        )
          throw Error("Invalid relationship.");
      }
    }
  }
}
