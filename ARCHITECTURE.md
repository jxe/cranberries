# Architecture

The configuration is four decisions: schema, collection, line and views.
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

Each document is one `dv_documents` row containing config, structured collections,
a revision and access flags. This targets small shared documents, not large data
warehouses. Supabase Postgres Changes streams committed row updates. Subscribe
first, then refresh after SUBSCRIBED and every reconnect to close the initial
snapshot/subscription gap. Ignore older revisions. No polling or Vercel SSE server.

The client overlays unsaved operations on the latest shared snapshot. It batches
text input, serializes its write requests, and preserves later edits while a write
is in flight. Reconnect refreshes the base and resumes the queue. Queued edits
remain in memory, with an unload warning; this is not an offline-first store.

`dv_apply` locks the document row and compares each field's previous value before
changing it. Different fields merge even from the same old revision. Same-field
conflicts stop saving and retain the local operations; the UI can download the
draft (including operations for remotely deleted records) or explicitly use the
shared version. This is optimistic conflict detection, not character-level CRDT
merging, cursor sharing or live field locking. A delete checks the entity's values
and removes every relationship to it in the same transaction. Membership editing
is a field edit, not entity deletion.

Each batch has a UUID receipt. A lost response can be retried without applying a
mutation twice. Receipts deliberately have no automatic expiry: expiring one while
a client may retry breaks idempotency. Long-term retention/compaction is future work.

## Trust boundary

Browser clients receive a publishable key. RLS limits reads; they cannot directly
update document rows or receipts. The security-definer RPC uses a fixed search
path, checks document write access and validates all data against the stored
schema before committing. Config and access flags are provisioned by a trusted
seed/migration, never supplied as part of a browser write. A service secret is
used only by the seed script. Private app login UI is outside this library.

## Current limits

SQL semantics are tested on PostgreSQL and client synchronization on an in-process
transport. The package ships TypeScript source for the host's bundler; there are no
compiled npm artifacts. Undo/history, durable offline drafts and granular
permissions are not implemented. Clearing an entity's name deletes it; apps that
need recovery should add history before treating this as production-grade editing.
