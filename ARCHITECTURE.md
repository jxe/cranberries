# Architecture

The configuration is four decisions: collections, the main one, line and views.
A record is an entity; each place it appears is an occurrence. Relationships use
stable IDs, including people. Renames do not rewrite relationships. React keys
use grouping and entity identity, never text values. The active editable span
keeps its DOM text node; incoming text waits until blur. Subsequent typing uses
the value the person actually saw as its comparison baseline.

## Boundaries

The core (`cranberries`, `/react`) knows React and Supabase, not Vite, Next.js,
React Router, TanStack Start, route loaders, server actions, environment variable
conventions, or any one site. `/app` adds browser startup glue, `/vite` an optional
env-mapping plugin, `/seed` a Node helper; none of them is required by the core. The host creates a Supabase client and supplies config plus an initial
snapshot. Server-rendering hosts can load that snapshot in their loader; the
Vite app loads it in the browser. The same DocumentEditor works in either case.

Site configuration and portrait rendering are application code. The optional
renderer callbacks change presentation, not entity identity or persistence.

## Writes and subscriptions

A write is split into a core and a storage adaptor. The core, `dv_apply`, locks
the document's `dv_documents` row (config, revision, access flags, adaptor name),
checks permission and the request ID, checks each operation against the config,
hands it to the adaptor, then raises the revision and adds one row to
`dv_changes`. All of it is one transaction, so the log and the records cannot
disagree. The library assumes it is the only writer of the records.

An adaptor owns only where records live: read every record, apply one operation
(reporting a conflict if the value the editor saw no longer holds), and replace
all records. `triples` stores one fact per row; `tables` stores a USL document
in the tables its schema lays out. Adaptors run inside the server function's
transaction, so they share it.

A site keeps no SQL. `cranberries setup` (src/setup.ts, src/cli.ts) applies
the library's `sql/schema.sql` in the site's Postgres schema and the setup SQL
`@ovst/usl` writes for the site's `.usl`, in one transaction; both create only
what is missing. The tables adaptor also makes missing tables when a document
is provisioned, configured or moved to it, so a schema that gains a model
needs no separate step. Changing or dropping a column is a migration of its
own.

`dv_changes` is the same for every adaptor. Supabase Postgres Changes streams
its inserts; a page applies each change whose revision follows its own, and
re-reads the document when it sees a gap. Subscribe first, then refresh after
SUBSCRIBED and every reconnect to close the initial snapshot/subscription gap.
No polling or Vercel SSE server.

The client overlays unsaved operations on the latest shared snapshot. It batches
text input, serializes its write requests, and preserves later edits while a write
is in flight. Reconnect refreshes the base and resumes the queue. Queued edits
remain in memory, with an unload warning; this is not an offline-first store.

Each field's previous value is compared before changing it. Different fields
merge even from the same old revision. Same-field conflicts stop saving, undo
the rest of the batch and retain the local operations; the UI can download the
draft (including operations for remotely deleted records) or explicitly use the
shared version. This is optimistic conflict detection, not character-level CRDT
merging, cursor sharing or live field locking. A relationship is changed one
member at a time (`link`, `unlink`) with no previous value, so two people
changing different members never conflict. A delete checks the entity's values
and removes every relationship to it in the same transaction.

`dv_apply` stamps a created or changed record with `modified`, a reserved key
beside `id`. Clients never write it: the overlay of unsaved operations leaves it
alone, and a delete is compared without it, so an edit followed by a delete in
one batch is not a conflict.

Each batch has a UUID, kept in its change log row. A lost response can be
retried without applying a mutation twice. The log is never trimmed: it is the
history, and trimming it would also break retries.

## Trust boundary

Browser clients receive a publishable key. With it they can read the change
log of a readable document, their live feed, and nothing else: they cannot
touch document rows, facts, the log or the sign-in tables. Everything else goes
through the server function, which holds the database secret. An older install
exposed database functions (`dv_apply` and others) to browsers; `schema.sql`
drops them, since they would write without asking who is writing.

The server function decides who is asking from one thing: the session token in
the request's Authorization header, looked up by its hash and good only while
the link it came from is not revoked. No token, no person, and no write. With
a person, it checks the document is open to writing, each operation against
the stored config, and for an owned collection, that the person is the admin
or one of the record's owners as stored before the operation. The writer named
in a change is the session's person.

A link's token is 32 random bytes shown once to whoever made the link. Sessions
are made from links (or from a passkey, which carries its link along), so
revoking a link ends everything that descends from it. Sessions do not expire
by themselves.

A passkey is made by someone already signed in and is stored as a credential
ID, a public key and the host name it was made on. The device keeps it and
offers it by itself (a discoverable credential), so signing in needs no name.
The server sets a random challenge, kept in the database for five minutes and
deleted when it is answered, right or wrong; it then checks the signature, the
challenge and the origin with `@simplewebauthn/server`. The origin it expects
is the one the request came to, so the same function serves any host name it
is deployed on, and a page elsewhere gets nothing to sign.

Config and access flags are provisioned by a trusted seed, never supplied as
part of a browser write. The admin's first link comes from a trusted script.
Presence, the faces of other visitors, is not verified.

## Current limits

SQL semantics are tested on PostgreSQL and client synchronization on an in-process
transport. The package ships TypeScript source for the host's bundler; there are no
compiled npm artifacts. The change feed has not yet run against Supabase
Realtime itself. The log records history but there is no undo UI; durable
offline drafts are not implemented. Permissions are signed in or not, owners,
and one admin; there are no roles beyond that, and a signed-in person can still
rename or remove people. Clearing an entity's name deletes it; apps that
need recovery should add history before treating this as production-grade editing.
