# cranberries

A configuration-driven React document editor with Supabase persistence and Realtime.
One collection, several editable arrangements: a record exists once and appears
under every group it belongs to. No dependency on a routing or server framework.

The package ships TypeScript source for the host's bundler to compile. Install it
from GitHub: `npm install github:jxe/cranberries`.

```tsx
import { createClient } from '@supabase/supabase-js';
import { c, defineDocument, readDocument, createSupabaseDocument } from 'cranberries';
import { DocumentEditor } from 'cranberries/react';
import 'cranberries/style.css';

const person = c.person();
const article = c.collection('article', {
  name: c.text(),
  authors: c.many(person),
  stage: c.choice(['Draft', 'Review', 'Published']),
});
const config = defineDocument({
  title: 'Editorial plan',
  collections: [person, article],
  main: article,
  line: ['name', 'authors', 'stage'],
  views: [
    c.view('By author', { groupBy: article.fields.authors }),
    c.view('By stage', { groupBy: 'stage' }),
  ],
});

// Bootstrap once, outside render. In a server-rendered app, load `initial` in
// the route loader and create the store once in a client component instead.
const client = createClient(url, publishableKey);
const initial = await readDocument(client, 'editorial');
const store = createSupabaseDocument({ client, documentId: 'editorial', config, initial });
root.render(<DocumentEditor store={store} />);
```

A site keeps no SQL of its own. `npx cranberries setup` sets up its database:
the library's tables and access rules (`sql/schema.sql`), and, for a document
described in USL, the tables its `lib/schema.usl` lays out. It reads
`DATABASE_URL` from the environment or `.env.local`, creates only what is
missing, and is safe to run again. `npx cranberries sql` prints the same SQL,
for pasting into the Supabase SQL editor. Both take `--usl <path>` and
`--schema <name>` (default `public`), or read them from `"cranberries": {
"usl", "schema" }` in the site's package.json. Then create the document from a
trusted seed script (see below), which sets up first too. The numbered files
beside `sql/schema.sql` are migrations for upgrading an older install's data;
a new install does not need them. Every record has a string `id`, a text `name`, and the
fields of its collection. Relationships contain IDs, not names.

## Configuration

A config is collections, the `main` one whose records are the lines, the `line`
of fields shown, and `views`. The builders are a typed way to write plain data:

```ts
{
  title: 'Editorial plan',
  collections: {
    person: { kind: 'person', fields: { name: { type: 'text' }, short: { type: 'text' }, image: { type: 'text' } } },
    article: {
      fields: {
        name: { type: 'text' },
        authors: { type: 'many', of: 'person' },
        stage: { type: 'choice', options: [{ name: 'Draft' }, { name: 'Review' }, { name: 'Published' }] },
      },
    },
  },
  main: 'article',
  line: ['name', 'authors', 'stage'],
  views: [{ label: 'By author', groupBy: 'authors' }, { label: 'By stage', groupBy: 'stage' }],
}
```

`defineDocument` accepts either, or a mix, and returns the plain form, which is
what the database stores and checks writes against. `Infer<typeof article>` is
the record type of a built collection.

Fields: `c.text()` (one required line), `c.longtext()` (may be empty, keeps line
breaks, shown under the line), `c.choice([...])` or `c.choice({ name: color })`,
and `c.many(collection)`. Options chain: `.default(value)` fills the field in
records written before it existed; `.bullet()` turns a choice into a colored
bullet and tints text fields; `.label(noun)` and `.summary()` on a relationship
name its members and show them as a count. On a collection, `.label(noun)` names
one of its records and `.fixed()` stops members being added or renamed in the editor.

`c.person()` is a collection of people, with `name`, `short` and `image` built
in. People are drawn with an avatar (their image, or initials) and named by
their short name where space is tight. `renderPrefix(type, entity)` and
`renderLabel(type, entity)` replace either for app-specific rendering.

### From a `.usl` schema

`documentFromUsl(source, { title })` builds the same config from
[Ultimate Schema Language](https://github.com/jxe/arbor/blob/main/docs/overstory-spec/11-schema-language.md),
the schema a Story collection uses, so one file can describe a document here and
in Story:

```
main model Article {
  name    Text
  stage   Stage
  authors Person[]
}
Article.authors[] @fold <-> Person.articles[]
Article.stage <-> Stage.articles[]
enum Stage { Draft, Review, Published }

re Article {
  ~views([
    { label: "By author", line: [name, authors ~label("author"), stage ~bullet], group: authors },
    { label: "By stage",  group: stage, sort: modified },
  ])
}
re Stage { Draft ~color("#9aa0aa") }
```

```ts
documentFromUsl(source, { title: "Articles", owners: { article: "authors" } });
```

The `main model` is the main collection and the first of its `~views` gives
the line. `Text` is a text field, `Markdown` a longtext one, a connection to an
`enum` is a choice with the `~color`s its `re` block gives, and an n:m
connection is a relationship on its `@fold` end. `Person` is the `person`
collection. In the line, `~bullet` and `~summary` are the options above and
`~label("…")` labels the related collection. What the language doesn't say is
given as options: `fixed` (collection keys), `admin`, `search`, and `owners`,
which names the person field whose people own each collection's records (who
may edit is access policy, not schema). Anything else throws a `SchemaError`.
The document's records go in the schema's own tables (see Storage).
`@ovst/usl` 0.3 or later is needed for this syntax. It ships TypeScript with
`.ts` import paths, so a host that typechecks needs
`"allowImportingTsExtensions": true`.

## Signing in

A visitor reads without signing in and changes nothing. To change anything they
need a sign-in link, which stands for one person in the collection of people.
Nobody picks who they are.

`admin: "<person id>"` in the config names the one person who hands out links.
The admin's own first link comes from a script with the database secret:

```ts
// scripts/admin-link.ts, run with DATABASE_URL in the environment
const server = createServer({ database: pgDatabase(pool), schema });
console.log(await server.adminLink(documentId, "https://my.site"));
```

Opening `https://my.site/?k=...` signs that browser in and takes the token out
of the address. Signed in, the admin's menu at the top right has "Sign-in
links": make a link for any person, see the links in use, revoke one. A link
works any number of times, on any device, until it is revoked; revoking it also
signs out every browser that came in by it.

Anyone signed in can add a passkey for the device they are on (Touch ID,
Windows Hello, a phone's screen lock). If that device is later signed out, the
menu offers "Sign in with a passkey" and the device does the rest; no name or
link is asked for. A passkey ends with the link its owner came in by. Passkeys
belong to a host name, so in development open `http://localhost:...`, not
`127.0.0.1`.

All of this is kept by the server function, not the page. Every write must
carry a session; the change is logged under that session's person, whatever
the request claims. The database holds hashes of link and session tokens and
the public half of each passkey. Passkeys are checked on the server with
`@simplewebauthn/server`, against a challenge that is good once, for five
minutes, and against the site the request came to (or pass `origins:
["https://my.site"]` to `createServer` to name the sites yourself).
`createSession({ endpoint, documentId })` is the browser's side, which
`mountDocument` sets up when given an `endpoint`; pass it as `session` to
`createSupabaseDocument` and the editor. The in-memory demo has no server, so
its visitor is the admin.

Other visitors' faces on the fields they are in are still only what each page
says about itself: decoration, not something to rely on.

The config's `title` is where a document's title starts; it is then saved with
the document and anyone who may write can change it in the page.

`.ownedBy("authors")` on a collection names a relationship to people who own
each record. A record with owners can be changed or removed only by one of
them, or the admin; a record with none, by anyone signed in, which is how it
gains an owner. Without it, anyone signed in can change anything. The server
function checks this on every operation, against the record as stored; the
page only hides what would be refused.

A view groups by a field of the main collection, by another collection's
relationship to it (rows keep that relationship's order), or not at all.
`sort: "modified"` puts the most recently changed first: rows in a flat or
field-grouped view, groups in a relationship view. The order is fixed when a
record is first shown, so a line does not move while it is edited.
`search: true` adds a box that filters lines by their text and related names.

Long text shows light markdown when it is not being edited: links, bare URLs,
`**bold**`, `*italic*`, `` `code` ``, `#` headings and `-` or `1.` list items.
It is built as elements, never HTML. Blank lines divide it into paragraphs. At
rest a field shows its first paragraph, up to five lines, with "Show more".

## Storage

Every committed write is one row in `dv_changes`: its operations, time and
writer. That log is the history and the live feed; pages receive each change
and apply it, and re-read the document if they miss one.

Where the records themselves live is up to the document's storage adaptor
(`src/server.ts`, `src/tables.ts`). `triples` keeps one fact per row
(`dv_facts`: record, field, value). `tables`, which a document built with
`documentFromUsl` gets, keeps its records in the tables USL lays out for the
schema: a table per collection and a join table per relationship, with an
`ordered` end's position column. Provisioning, configuring or moving such a
document makes any of its tables that are missing (`tablesSql(source,
schema)` prints that SQL); people, who have no table in USL, are kept in
`dv_people`. Those tables belong to one document. `server.move(document,
adaptor)` moves a document's records to another adaptor, keeping ids, order and
stamps.

When the config in code changes, `seedFromEnv` (or `server.configure`)
updates the stored copy. It is refused if existing records do not fit; give a
new field a `default` and they do.

To keep the library's tables apart from an existing application's, set them
up in a schema of their own (`--schema myschema`), add that schema to the
project's exposed schemas, and pass `schema: "myschema"` to `createServer`,
`createSupabaseDocument`, `readDocument`, `mountDocument` and `seedFromEnv`.

`createMemoryDocument(config, initial)` is an in-memory store for demos and tests.

`useDocument(store)` exposes `{data, revision, status, error, pending}` for custom
surrounding UI. `store.set`, `store.link`, `store.create`, and `store.remove`
update shared entities; `link` adds or removes one member of a relationship. `store.exportDraft()` returns visible data and pending operations.
`store.useRemote()` explicitly discards pending changes after a conflict.

## A whole site in a few lines

`cranberries/app` wraps the bootstrap above: it connects when a URL and key are
given and otherwise runs an in-memory demo.

```tsx
// vite.config.ts
import { cranberries } from "cranberries/vite";
export default defineConfig({ plugins: [cranberries()] });

// src/main.tsx
import { mountDocument } from "cranberries/app";
await mountDocument(document.getElementById("root")!, {
  documentId: "editorial", config, demoData,
  url: import.meta.env.VITE_SUPABASE_URL,
  publishableKey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
  requireSupabase: import.meta.env.PROD,
});

// scripts/seed.ts, run with DATABASE_URL in the environment
import { seedFromEnv } from "cranberries/seed";
await seedFromEnv({ documentId: "editorial", config, data, publicRead: true });
```

The server function imports `cranberries/server`, which is bundled into
`dist/server.js` (with `@ovst/usl`) when the package is installed from GitHub,
since hosts such as Vercel do not load TypeScript from `node_modules`. Vite's
dev server uses the source. With a local `npm link`, run `npm run build` here
after changing server code.

`seedFromEnv` sets up the database (`setupDatabase`, as `cranberries setup`
does), then creates the document if it is missing and otherwise syncs its
config.

The plugin only maps the host's Supabase URL and publishable key onto those two
`import.meta.env` names. `wrap`, `renderPrefix` and `renderLabel` add site chrome.

`npm test` covers sessions, grouping, synchronization, retries and conflicts.
`npm run test:db:local` runs the server function against a temporary local
PostgreSQL: writes, sign-in links, revoking, passkeys and ownership.

## React Router / TanStack Start

Import the same package, CSS and component. Fetch the initial snapshot in a loader
or in browser bootstrap, pass in your Supabase client, and hold the store with
`useState(() => createSupabaseDocument(...))`. Do not create a new store on every
render. Create a new keyed editor when switching document IDs. There are no API
routes, server functions or framework-specific environment variables to copy.

Signing in is the library's own (see above), not Supabase Auth. Never ship a
service secret or the database URL to a browser.

See ARCHITECTURE.md for concurrency semantics, access policy and limits.
Supabase reference: https://supabase.com/docs/guides/realtime/postgres-changes
