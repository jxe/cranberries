// The tables adaptor: a document described in USL keeps its records in the
// tables USL lays out for it (usl.ts makes them with `tablesSql`), one row per
// record and one join-table row per relationship member. The layout of the
// config's `usl` says which columns hold each field (`Table.fields`) and the
// sides of each join table (`Table.ends`). People have no table in USL, so
// they are kept here in dv_people, one row per person of the document.
//
// A collection reads in the order its records were made (`created`); so do
// the members of a relationship, unless it is @ordered, when its position
// column orders them. A record with no `modified` stamp, which only a port
// from another adaptor makes, keeps '-infinity' in that column.
//
// The tables hold one document's records, so no two documents may share them.
import type { Adaptor, Doc, Tables, Tx } from "./server";
import type { Config, Data, Entity, Field } from "./model";
import { storageOf, tablesSql } from "./usl";

const people = ["name", "short", "image"];
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
// A stamp as the triples adaptor keeps it, text from toISOString.
const stamped = (column: string) =>
  `case when ${column} = '-infinity' then null else to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end`;
const fallback = (d: Field) =>
  d.type === "many"
    ? []
    : (d.default ?? (d.type === "choice" ? d.options[0].name : ""));

// Where one collection's records are: its table, the column of each text or
// choice field, and the join table of each relationship, whose `from` column
// holds this record's id and `to` the member's. `position` orders the members
// when the relationship is @ordered; `back` orders the other way, when that
// end is.
type Join = {
  table: string;
  from: string;
  to: string;
  position?: string;
  back?: string;
};
type Place = {
  table: string;
  columns: Record<string, string>;
  joins: Record<string, Join>;
};
const places = new WeakMap<object, Map<string, Place>>();
// The table of a collection, or nothing for the document's people.
function placeOf(config: Config, type: string): Place | undefined {
  const collection = config.collections[type];
  if (collection?.kind === "person") {
    for (const field of Object.keys(collection.fields))
      if (!people.includes(field)) throw Error(`People have no ${field}`);
    return undefined;
  }
  const { tables, models } = storageOf(config);
  let known = places.get(tables);
  if (!known) places.set(tables, (known = new Map()));
  if (known.has(type)) return known.get(type);
  const model = models[type];
  const table = tables.find((t) => t.stores === model);
  if (!table || !collection) throw Error(`No table for ${type}`);
  const place: Place = { table: table.name, columns: {}, joins: {} };
  for (const [name, d] of Object.entries(collection.fields)) {
    if (d.type !== "many") {
      const field = table.fields.find((f) => f.name === name);
      if (field?.columns.length !== 1) throw Error(`No column for ${name}`);
      place.columns[name] = field.columns[0];
      continue;
    }
    const join = tables.find((t) =>
      t.ends?.some((e) => e.model === model && e.field === name),
    );
    const [mine, other] =
      join?.ends?.[0].model === model && join.ends[0].field === name
        ? join.ends
        : [join?.ends?.[1], join?.ends?.[0]];
    if (!join || !mine || !other) throw Error(`No join table for ${name}`);
    place.joins[name] = {
      table: join.name,
      from: mine.columns[0],
      to: other.columns[0],
      ...(mine.position ? { position: mine.position } : {}),
      ...(other.position ? { back: other.position } : {}),
    };
  }
  known.set(type, place);
  return place;
}

// The records of one collection, or the one record `id`.
async function rows(
  tx: Tx,
  t: Tables,
  doc: Doc,
  type: string,
  id?: string,
): Promise<Entity[]> {
  const fields = doc.config.collections[type].fields;
  const place = placeOf(doc.config, type);
  const table = (name: string) => `${t.schema}.${quote(name)}`;
  let found: Record<string, string | null>[];
  if (!place)
    found = await tx.query(
      `select id, modified, ${people.map(quote).join(", ")} from ${t("people")}
       where document_id = $1 ${id === undefined ? "" : "and id = $2"} order by seq`,
      id === undefined ? [doc.id] : [doc.id, id],
    );
  else
    found = await tx.query(
      `select id, ${stamped("modified")} as modified, ${Object.entries(
        place.columns,
      )
        .map(([field, column]) => `${quote(column)} as ${quote(field)}`)
        .join(", ")} from ${table(place.table)}
       ${id === undefined ? "" : "where id = $1"} order by created, id`,
      id === undefined ? [] : [id],
    );
  const members = new Map<string, Map<string, string[]>>();
  for (const [field, join] of Object.entries(place?.joins ?? {})) {
    const of = new Map<string, string[]>();
    const links = await tx.query<{ from: string; to: string }>(
      `select ${quote(join.from)} as "from", ${quote(join.to)} as "to" from ${table(join.table)}
       ${id === undefined ? "" : `where ${quote(join.from)} = $1`}
       order by ${join.position ? quote(join.position) + ", " : ""}created, ${quote(join.to)}`,
      id === undefined ? [] : [id],
    );
    for (const link of links)
      of.set(link.from, [...(of.get(link.from) ?? []), link.to]);
    members.set(field, of);
  }
  return found.map((row) => {
    const entity: Entity = { id: row.id! };
    if (row.modified !== null) entity.modified = row.modified;
    for (const [name, d] of Object.entries(fields))
      entity[name] =
        d.type === "many"
          ? (members.get(name)?.get(row.id!) ?? [])
          : (row[name] ?? (fallback(d) as string));
    return entity;
  });
}

// Every member must be a record of `type`.
async function related(
  tx: Tx,
  t: Tables,
  doc: Doc,
  type: string,
  ids: string[],
) {
  if (!ids.length) return;
  const place = placeOf(doc.config, type);
  const [{ n }] = await tx.query<{ n: string }>(
    place
      ? `select count(*) n from ${t.schema}.${quote(place.table)} where id = any($1::text[])`
      : `select count(*) n from ${t("people")} where document_id = $2 and id = any($1::text[])`,
    place ? [ids] : [ids, doc.id],
  );
  if (Number(n) !== new Set(ids).size) throw Error("Missing related entity");
}

// Join rows for `ids`, after the ones already there. `created` is the stamp,
// a microsecond apart each, so that unordered members keep this order too.
async function addMembers(
  tx: Tx,
  t: Tables,
  join: Place["joins"][string],
  from: string,
  ids: string[],
  stamp: string,
  clock: { n: number },
) {
  const table = `${t.schema}.${quote(join.table)}`;
  for (const to of ids) {
    const columns = [join.from, join.to, "created", "modified"];
    const values = [
      "$1",
      "$2",
      "$3::timestamptz + $4 * interval '1 microsecond'",
      "$3::timestamptz",
    ];
    if (join.position) {
      columns.push(join.position);
      values.push(
        `coalesce((select max(${quote(join.position)}) from ${table} where ${quote(join.from)} = $1), -1) + 1`,
      );
    }
    if (join.back) {
      columns.push(join.back);
      values.push(
        `coalesce((select max(${quote(join.back)}) from ${table} where ${quote(join.to)} = $2), -1) + 1`,
      );
    }
    await tx.query(
      `insert into ${table}(${columns.map(quote).join(", ")}) values (${values.join(", ")})`,
      [from, to, stamp, clock.n++],
    );
  }
}

// `modified` is the record's own stamp, or none; `stamp` is when it is made.
async function insert(
  tx: Tx,
  t: Tables,
  doc: Doc,
  type: string,
  row: Entity,
  stamp: string,
  clock: { n: number },
  check = true,
) {
  const fields = doc.config.collections[type].fields;
  const value = (name: string) => row[name] ?? fallback(fields[name]);
  const place = placeOf(doc.config, type);
  if (!place) {
    await tx.query(
      `insert into ${t("people")}(document_id, id, modified, ${people.map(quote).join(", ")}) values ($1, $2, $3, $4, $5, $6)`,
      [doc.id, row.id, row.modified ?? null, ...people.map(value)],
    );
    return;
  }
  const columns = Object.entries(place.columns);
  await tx.query(
    `insert into ${t.schema}.${quote(place.table)}(id, created, modified, ${columns.map(([, c]) => quote(c)).join(", ")})
     values ($1, $2::timestamptz + $3 * interval '1 microsecond', coalesce($4::timestamptz, '-infinity'), ${columns.map((_, i) => `$${i + 5}`).join(", ")})`,
    [
      row.id,
      stamp,
      clock.n++,
      row.modified ?? null,
      ...columns.map(([name]) => value(name)),
    ],
  );
  for (const [field, join] of Object.entries(place.joins)) {
    const ids = (row[field] as string[] | undefined) ?? [];
    const of = fields[field] as Extract<Field, { type: "many" }>;
    if (check) await related(tx, t, doc, of.of, ids);
    await addMembers(tx, t, join, row.id, ids, stamp, clock);
  }
}

async function touch(
  tx: Tx,
  t: Tables,
  doc: Doc,
  type: string,
  id: string,
  stamp: string,
) {
  const place = placeOf(doc.config, type);
  await tx.query(
    place
      ? `update ${t.schema}.${quote(place.table)} set modified = $2 where id = $1`
      : `update ${t("people")} set modified = $2 where id = $1 and document_id = $3`,
    place ? [id, stamp] : [id, stamp, doc.id],
  );
}

// Every table the document's records are in.
const tablesOf = (config: Config) =>
  storageOf(config).tables.map((table) => table.name);

export const tables: Adaptor = {
  async setup(tx, t, config) {
    if (!config.usl) throw Error("The config has no USL schema.");
    await tx.query(tablesSql(config.usl, t.schema));
  },
  async read(tx, t, doc) {
    const data: Data = {};
    for (const type of Object.keys(doc.config.collections))
      data[type] = await rows(tx, t, doc, type);
    return data;
  },
  async get(tx, t, doc, type, id) {
    return (await rows(tx, t, doc, type, id))[0];
  },
  async init(tx, t, doc, data) {
    const mine = tablesOf(doc.config);
    const others = await tx.query<{ id: string; config: Config }>(
      `select id, config from ${t("documents")} where adaptor = 'tables' and id <> $1`,
      [doc.id],
    );
    for (const other of others)
      if (tablesOf(other.config).some((table) => mine.includes(table)))
        throw Error(
          `Document ${other.id} keeps its records in the same tables.`,
        );
    // Join tables first, for their foreign keys.
    for (const table of mine.reverse())
      await tx.query(`delete from ${t.schema}.${quote(table)}`);
    await tx.query(`delete from ${t("people")} where document_id = $1`, [
      doc.id,
    ]);
    const [{ now }] = await tx.query<{ now: string }>(
      `select to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as now`,
    );
    const clock = { n: 0 };
    // Everything a relationship points to is in first; the whole document
    // was checked beforehand.
    const types = Object.keys(doc.config.collections);
    for (const type of types)
      for (const row of data[type] ?? [])
        await insert(
          tx,
          t,
          doc,
          type,
          { ...row, ...emptied(doc.config, type) },
          now,
          clock,
          false,
        );
    for (const type of types) {
      const place = placeOf(doc.config, type);
      for (const [field, join] of Object.entries(place?.joins ?? {}))
        for (const row of data[type] ?? [])
          await addMembers(
            tx,
            t,
            join,
            row.id,
            (row[field] as string[]) ?? [],
            now,
            clock,
          );
    }
  },
  async apply(tx, t, doc, op, stamp) {
    const current = await tables.get(tx, t, doc, op.type, op.id);
    const same = (a: unknown, b: unknown) =>
      JSON.stringify(a) === JSON.stringify(b);
    const clock = { n: 0 };
    const place = placeOf(doc.config, op.type);
    if (op.kind === "create") {
      if (current) return "An entity with this ID already exists.";
      await insert(
        tx,
        t,
        doc,
        op.type,
        { ...op.value, modified: stamp },
        stamp,
        clock,
      );
      return null;
    }
    if (op.kind === "delete") {
      const keys = (o: object) =>
        Object.entries(o)
          .filter(([k]) => k !== "modified")
          .sort();
      if (!current || !same(keys(current), keys(op.before)))
        return "The entity changed before deletion.";
      // Every relationship to the record goes with it.
      for (const [type, c] of Object.entries(doc.config.collections))
        for (const [name, d] of Object.entries(c.fields))
          if (d.type === "many" && d.of === op.type) {
            const join = placeOf(doc.config, type)!.joins[name];
            await tx.query(
              `delete from ${t.schema}.${quote(join.table)} where ${quote(join.to)} = $1`,
              [op.id],
            );
          }
      for (const join of Object.values(place?.joins ?? {}))
        await tx.query(
          `delete from ${t.schema}.${quote(join.table)} where ${quote(join.from)} = $1`,
          [op.id],
        );
      await tx.query(
        place
          ? `delete from ${t.schema}.${quote(place.table)} where id = $1`
          : `delete from ${t("people")} where id = $1 and document_id = $2`,
        place ? [op.id] : [op.id, doc.id],
      );
      return null;
    }
    const field = doc.config.collections[op.type].fields[op.field];
    const members = (current?.[op.field] as string[] | undefined) ?? [];
    if (op.kind === "set") {
      if (!current || !same(current[op.field], op.before))
        return "Someone else changed this field. Your draft is retained; copy it before using the shared version.";
    } else if (op.kind === "link") {
      if (!current) return "The entity no longer exists.";
      if (members.includes(op.value)) return null;
    } else if (!members.includes(op.value)) return null;
    if (field.type !== "many") {
      if (place)
        await tx.query(
          `update ${t.schema}.${quote(place.table)} set ${quote(place.columns[op.field])} = $2 where id = $1`,
          [op.id, op.value],
        );
      else
        await tx.query(
          `update ${t("people")} set ${quote(op.field)} = $2 where id = $1 and document_id = $3`,
          [op.id, op.value, doc.id],
        );
    } else {
      const join = place!.joins[op.field];
      const table = `${t.schema}.${quote(join.table)}`;
      const next =
        op.kind === "set"
          ? (op.value as string[])
          : op.kind === "link"
            ? [...members, op.value]
            : members.filter((m) => m !== op.value);
      await related(tx, t, doc, field.of, next);
      const gone = members.filter((m) => !next.includes(m));
      await tx.query(
        `delete from ${table} where ${quote(join.from)} = $1 and ${quote(join.to)} = any($2::text[])`,
        [op.id, gone],
      );
      await addMembers(
        tx,
        t,
        join,
        op.id,
        next.filter((m) => !members.includes(m)),
        stamp,
        clock,
      );
      // A new order for the members that stay.
      if (join.position && op.kind === "set")
        await tx.query(
          `update ${table} set ${quote(join.position)} = u.n - 1, modified = $3
           from unnest($2::text[]) with ordinality u(id, n)
           where ${quote(join.from)} = $1 and ${quote(join.to)} = u.id and ${quote(join.position)} <> u.n - 1`,
          [op.id, next, stamp],
        );
    }
    await touch(tx, t, doc, op.type, op.id, stamp);
    return null;
  },
};

// A record without its relationships, which go in once every record is.
const emptied = (config: Config, type: string) =>
  Object.fromEntries(
    Object.entries(config.collections[type].fields).flatMap(([name, d]) =>
      d.type === "many" ? [[name, []]] : [],
    ),
  );
