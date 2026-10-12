// Builders for a config: `c.text()`, `c.many(person)`, `c.choice({...}).bullet()`.
// Each holds the plain stored shape in `def` and turns into it as JSON, so a
// config can mix builders and literals and only plain data reaches the database.
import type { Collection, Field, GroupBy, Option, View } from "./model";
type Ref = { collection: string; field: string };
type Text = { type: "text" | "longtext"; default?: string };
type Choice<N extends string> = {
  type: "choice";
  options: (Option & { name: N })[];
  bullet?: boolean;
  default?: N;
};
type Many = { type: "many"; of: string; label?: string; summary?: boolean };
class Built<F extends Field> {
  constructor(
    readonly def: F,
    // Where the field sits, once it is part of a collection.
    readonly ref?: Ref,
  ) {}
  protected with(change: Partial<F>) {
    return new (this.constructor as new (def: F, ref?: Ref) => this)(
      { ...this.def, ...change },
      this.ref,
    );
  }
  at(ref: Ref) {
    return new (this.constructor as new (def: F, ref?: Ref) => this)(
      this.def,
      ref,
    );
  }
  toJSON() {
    return this.def;
  }
}
class TextField extends Built<Text> {
  default(value: string) {
    return this.with({ default: value });
  }
}
class ChoiceField<N extends string> extends Built<Choice<N>> {
  bullet() {
    return this.with({ bullet: true } as Partial<Choice<N>>);
  }
  default(name: N) {
    return this.with({ default: name } as Partial<Choice<N>>);
  }
}
class ManyField extends Built<Many> {
  label(label: string) {
    return this.with({ label });
  }
  summary() {
    return this.with({ summary: true });
  }
}
type Fields = Record<string, Built<Field>>;
export class BuiltCollection<K extends string, F extends Fields> {
  readonly fields: F;
  constructor(
    readonly key: K,
    fields: F,
    private options: Omit<Collection, "fields"> = {},
  ) {
    this.fields = Object.fromEntries(
      Object.entries(fields).map(([name, f]) => [
        name,
        f.at({ collection: key, field: name }),
      ]),
    ) as F;
  }
  label(label: string) {
    return new BuiltCollection(this.key, this.fields, {
      ...this.options,
      label,
    });
  }
  fixed() {
    return new BuiltCollection(this.key, this.fields, {
      ...this.options,
      fixed: true,
    });
  }
  toJSON(): Collection {
    return {
      ...this.options,
      fields: Object.fromEntries(
        Object.entries(this.fields).map(([name, f]) => [name, f.def]),
      ),
    };
  }
}
type PersonFields = { name: TextField; short: TextField; image: TextField };
export const c = {
  text: () => new TextField({ type: "text" }),
  longtext: () => new TextField({ type: "longtext" }),
  // Options in order: names, or names with their colors.
  choice: <const N extends string>(options: readonly N[] | Record<N, string>) =>
    new ChoiceField<N>({
      type: "choice",
      options: Array.isArray(options)
        ? options.map((name: N) => ({ name }))
        : Object.entries<string>(options as Record<N, string>).map(
            ([name, color]) => ({ name: name as N, color }),
          ),
    }),
  // A relationship to a collection, built or named (a name lets two
  // collections point at each other).
  many: (of: string | { key: string }) =>
    new ManyField({ type: "many", of: typeof of === "string" ? of : of.key }),
  collection: <K extends string, F extends Fields>(key: K, fields: F) =>
    new BuiltCollection(key, fields),
  // A collection of people: `name`, `short` and `image` are built in.
  person: <
    K extends string = "person",
    F extends Fields = Record<never, never>,
  >(
    key = "person" as K,
    fields = {} as F,
  ) =>
    new BuiltCollection<K, PersonFields & F>(
      key,
      { name: c.text(), short: c.text(), image: c.text(), ...fields },
      { kind: "person" },
    ),
  // A view, grouped by a built field or as `groupBy` is written in a config.
  view: (
    label: string,
    options: { groupBy?: GroupBy | { ref?: Ref }; sort?: "modified" } = {},
  ): View => {
    const by = options.groupBy;
    const groupBy =
      typeof by === "object" && !("collection" in by) ? by.ref : by;
    return {
      label,
      ...(groupBy ? { groupBy } : {}),
      ...(options.sort ? { sort: options.sort } : {}),
    };
  },
};
// The record type of a built collection.
export type Infer<C extends { fields: Fields }> = {
  id: string;
  modified?: string;
} & {
  [N in keyof C["fields"]]: C["fields"][N]["def"] extends { type: "many" }
    ? string[]
    : C["fields"][N]["def"] extends {
          type: "choice";
          options: { name: infer O }[];
        }
      ? O
      : string;
};
