export type Value = string | string[];
export type Entity = { id: string; [field: string]: Value };
export type Data = Record<string, Entity[]>;
// "text" is a single required line; "longtext" may be empty and span lines.
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
};
// Group by a field of the collection, by another collection's relationship to
// it (rows keep that relationship's order), or omit groupBy for a flat view.
export type GroupBy = string | { collection: string; field: string };
export type View = { label: string; groupBy?: GroupBy };
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
    if (schema.name !== "text" || "id" in schema)
      throw Error("Each collection needs a text name; id is reserved.");
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
export function apply(config: Config, data: Data, op: Operation): Data {
  if (op.kind === "create")
    return {
      ...data,
      [op.type]: [
        ...(data[op.type] ?? []).filter((r) => r.id !== op.id),
        op.value,
      ],
    };
  if (op.kind === "set")
    return {
      ...data,
      [op.type]: (data[op.type] ?? []).map((r) =>
        r.id === op.id ? { ...r, [op.field]: op.value } : r,
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
      if (Object.keys(row).some((k) => k !== "id" && !(k in schema)))
        throw Error("Unknown field.");
      for (const [field, d] of Object.entries(schema)) {
        const v = row[field];
        if (typeof d === "string") {
          if (typeof v !== "string" || v.length > 10000)
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
