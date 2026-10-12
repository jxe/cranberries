# cranberries

A configuration-driven React document editor with Supabase persistence and Realtime.
One collection, several editable arrangements: a record exists once and appears
under every group it belongs to. No dependency on a routing or server framework.

The package ships TypeScript source for the host's bundler to compile. Install it
from GitHub: `npm install github:jxe/cranberries`.

```tsx
import { createClient } from '@supabase/supabase-js';
import { defineDocument, readDocument, createSupabaseDocument } from 'cranberries';
import { DocumentEditor } from 'cranberries/react';
import 'cranberries/style.css';

const config = defineDocument({
  title: 'Editorial plan',
  schema: {
    person: { name: 'text' },
    article: {
      name: 'text',
      authors: { many: 'person' },
      stage: { choices: ['Draft', 'Review', 'Published'] },
    },
  },
  collection: 'article',
  line: ['name', 'authors', 'stage'],
  views: [
    { label: 'By author', groupBy: 'authors' },
    { label: 'By stage', groupBy: 'stage' },
  ],
});

// Bootstrap once, outside render. In a server-rendered app, load `initial` in
// the route loader and create the store once in a client component instead.
const client = createClient(url, publishableKey);
const initial = await readDocument(client, 'editorial');
const store = createSupabaseDocument({ client, documentId: 'editorial', config, initial });
root.render(<DocumentEditor store={store} />);
```

Provision a `dv_documents` row with matching config and data using a trusted server
client. Every collection is an array of records with a string `id`, a text `name`,
and all the fields declared in its schema. Relationships contain IDs, not names.
Run `sql/001_document_views.sql` first. Realtime is enabled by that migration.

Optional presentation hints: relationship `label` and `summary: true` create a
count badge; choice `colors` and `bullet: true` turn the choice into a colored
bullet and tint text fields. `labels` supplies singular collection labels for
add/remove controls. `renderPrefix(type, entity)` and `renderLabel(type, entity)`
keep portraits or other app-specific rendering outside the library.

Field kinds: `"text"` (one required line), `"longtext"` (may be empty, keeps line
breaks, shown under the line), `{ choices }` and `{ many }`. A view groups by a
field of the collection (`groupBy: "authors"`), by another collection's
relationship to it (`groupBy: { collection: "list", field: "games" }`, rows keep
that relationship's order), or not at all (omit `groupBy`). `fixed: ["person"]`
lists collections whose members cannot be added or renamed in the editor.
Run `sql/002_longtext.sql` after 001 before storing a `longtext` field.

Long text shows light markdown when it is not being edited: links, bare URLs,
`**bold**`, `*italic*`, `` `code` ``, `#` headings and `-` or `1.` list items.
It is built as elements, never HTML. `search: true` adds a box that filters lines
by their text and related names. Every write stamps its record with `modified`
(set by the database, not editable); `sort: "modified"` on a view puts the most
recently changed first: rows in a flat or field-grouped view, groups in a
relationship view. The order is fixed when a record is first shown, so a line
does not move while it is edited. Run `sql/003_modified.sql` after 002 for
stamps and for long text up to 100,000 characters.

`createMemoryDocument(config, initial)` is an in-memory store for demos and tests.
`provisionDocument(secretClient, {...})` creates a document row from a seed script.

`useDocument(store)` exposes `{data, revision, status, error, pending}` for custom
surrounding UI. `store.set`, `store.create`, and `store.remove` update shared
entities. `store.exportDraft()` returns visible data and pending operations.
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

// scripts/seed.ts, run with the secret key in the environment
import { seedFromEnv } from "cranberries/seed";
await seedFromEnv({ documentId: "editorial", config, data, publicRead: true });
```

The plugin only maps the host's Supabase URL and publishable key onto those two
`import.meta.env` names. `wrap`, `renderPrefix` and `renderLabel` add site chrome.

`npm test` covers identity, grouping, synchronization, retries and conflicts.
`npm run test:db:local` runs the SQL tests on a temporary local PostgreSQL.

## React Router / TanStack Start

Import the same package, CSS and component. Fetch the initial snapshot in a loader
or in browser bootstrap, pass in your Supabase client, and hold the store with
`useState(() => createSupabaseDocument(...))`. Do not create a new store on every
render. Create a new keyed editor when switching document IDs. There are no API
routes, server functions or framework-specific environment variables to copy.

Supabase sessions/auth are owned by the host. Private documents require the signed-in
client for both snapshot loading and subscription. Never ship a service secret.

See ARCHITECTURE.md for concurrency semantics, access policy and limits.
Supabase reference: https://supabase.com/docs/guides/realtime/postgres-changes
