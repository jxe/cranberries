export type Value = string | string[];
// `modified` is stamped by the database when a write to the record lands.
export type Entity = { id: string; modified?: string } & {
  [field: string]: Value;
};
export type Data = Record<string, Entity[]>;
// "text" is a single required line; "longtext" may be empty, span lines and
// use light markdown (see markdown.ts).
export const limits = { text: 10000, longtext: 100000 };
export type Field =
  | "text"
  | "longtext"
  | { many: string; label?: string; summary?: boolean }
  | { choices: string[]; colors?: Record<string, string>; bullet?: boolean };
export type Config = {
  title: string;
  schema: Record<string, Record<string, Field>>;
  collection: string;
  line: string[];
  views: View[];
  labels?: Record<string, string>;
  // Collections whose members are provisioned, not added or renamed in the editor.
  fixed?: string[];
  // Show a box that filters lines by their text and related names.
  search?: boolean;
};
// Group by a field of the collection, by another collection's relationship to
// it (rows keep that relationship's order), or omit groupBy for a flat view.
export type GroupBy = string | { collection: string; field: string };
// sort: "modified" puts the most recently changed first: rows in a flat or
// field-grouped view, groups in a relationship view (whose rows keep its order).
export type View = { label: string; groupBy?: GroupBy; sort?: "modified" };
export type Snapshot = { data: Data; revision: number };
export type Operation =
  | {
      kind: "set";
      type: string;
      id: string;
      field: string;
      before: Value;
      value: Value;
    }
  | { kind: "create"; type: string; id: string; value: Entity }
  | { kind: "delete"; type: string; id: string; before: Entity };
export const equal = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
export function defineDocument<T extends Config>(config: T): T {
  const fields = config.schema[config.collection];
  if (!fields || !config.views.length || !config.line.length)
    throw Error("A collection, line, and views are required.");
  for (const schema of Object.values(config.schema)) {
    if (schema.name !== "text" || "id" in schema || "modified" in schema)
      throw Error(
        "Each collection needs a text name; id and modified are reserved.",
      );
    for (const field of Object.values(schema))
      if (
        typeof field === "object" &&
        "many" in field &&
        !config.schema[field.many]
      )
        throw Error("Unknown relationship collection.");
  }
  for (const field of config.line)
    if (!fields[field]) throw Error(`Unknown line field: ${field}`);
  for (const view of config.views) {
    if (view.groupBy === undefined) continue;
    if (typeof view.groupBy === "object") {
      const d = config.schema[view.groupBy.collection]?.[view.groupBy.field];
      if (
        typeof d !== "object" ||
        !("many" in d) ||
        d.many !== config.collection
      )
        throw Error("Group by a relationship to the collection.");
    } else if (typeof fields[view.groupBy] !== "object")
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
  const all = data[config.collection] ?? [];
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
  const descriptor = config.schema[config.collection][field];
  if (typeof descriptor !== "object") return [];
  const candidates =
    "many" in descriptor
      ? (data[descriptor.many] ?? []).map((r) => ({
          id: r.id,
          name: String(r.name),
          type: descriptor.many,
        }))
      : descriptor.choices.map((name) => ({ id: name, name, type: null }));
  const rows = data[config.collection] ?? [];
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
  const schema = config.schema[config.collection];
  const haystack = (row: Entity) =>
    Object.entries(schema)
      .map(([name, d]) =>
        typeof d === "object" && "many" in d
          ? (row[name] as string[])
              .map((id) => data[d.many]?.find((r) => r.id === id)?.name ?? "")
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
    ...Object.entries(config.schema[type]).map(([name, field]) => [
      name,
      typeof field === "string"
        ? name === "name"
          ? `New ${config.labels?.[type] ?? type}`
          : ""
        : "many" in field
          ? []
          : (field.choices[0] ?? ""),
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
  if (op.kind === "set")
    return {
      ...data,
      [op.type]: (data[op.type] ?? []).map((r) =>
        r.id === op.id ? { ...r, [op.field]: op.value, ...stamp } : r,
      ),
    };
  const result: Data = {};
  for (const [type, rows] of Object.entries(data))
    result[type] = rows
      .filter((r) => type !== op.type || r.id !== op.id)
      .map((r) => {
        const next = { ...r };
        for (const [field, descriptor] of Object.entries(config.schema[type]))
          if (
            typeof descriptor === "object" &&
            "many" in descriptor &&
            descriptor.many === op.type
          )
            next[field] = (r[field] as string[]).filter((id) => id !== op.id);
        return next;
      });
  return result;
}
export function validate(config: Config, data: Data) {
  for (const [type, schema] of Object.entries(config.schema)) {
    if (!Array.isArray(data[type])) throw Error(`Missing collection ${type}`);
    const ids = new Set<string>();
    for (const row of data[type]) {
      if (!row.id || ids.has(row.id))
        throw Error("Missing or duplicate entity ID.");
      ids.add(row.id);
      if (
        Object.keys(row).some(
          (k) => k !== "id" && k !== "modified" && !(k in schema),
        )
      )
        throw Error("Unknown field.");
      if (row.modified !== undefined && typeof row.modified !== "string")
        throw Error("Invalid modified time.");
      for (const [field, d] of Object.entries(schema)) {
        const v = row[field];
        if (typeof d === "string") {
          if (typeof v !== "string" || v.length > limits[d])
            throw Error("Invalid text.");
        } else if ("choices" in d) {
          if (typeof v !== "string" || !d.choices.includes(v))
            throw Error("Invalid choice.");
        } else if (
          !Array.isArray(v) ||
          new Set(v).size !== v.length ||
          v.some((id) => !(data[d.many] ?? []).some((r) => r.id === id))
        )
          throw Error("Invalid relationship.");
      }
    }
  }
}
