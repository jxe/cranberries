// Startup glue shared by sites: connect to Supabase when configured, otherwise
// run an in-memory demo. Knows React and the browser, not a bundler or router.
import { useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { createClient } from "@supabase/supabase-js";
import type { Config, Data, Snapshot } from "./model";
import { createMemoryDocument } from "./memory";
import { createSupabaseDocument, loadDocument } from "./supabase";
import { DocumentEditor, type DocumentEditorProps } from "./react";
import { createSession, demoSession, type Session } from "./session";
export type DocumentAppOptions = {
  documentId: string;
  config: Config;
  // Shown when no Supabase project is configured. Edits reset on reload.
  demoData: Data;
  url?: string;
  publishableKey?: string;
  // Where the migrations were installed, when not `public`.
  schema?: string;
  // The server function that reads and writes (see `cranberries/server`).
  endpoint?: string;
} & Pick<DocumentEditorProps, "renderPrefix" | "renderLabel">;
export function DocumentApp({
  initial,
  documentId,
  config,
  url,
  publishableKey,
  schema,
  endpoint,
  renderPrefix,
  renderLabel,
  session,
}: DocumentAppOptions & { initial: Snapshot; session: Session }) {
  const [client] = useState(() =>
    url && publishableKey
      ? createClient(url, publishableKey, {
          realtime: { worker: typeof Worker !== "undefined" },
        })
      : null,
  );
  const [store] = useState(() => {
    const store = client
      ? createSupabaseDocument({
          client,
          documentId,
          config,
          initial,
          schema,
          endpoint,
          session,
        })
      : createMemoryDocument(config, initial);
    store.me = () => session.state().person;
    return store;
  });
  return (
    <>
      {!client && (
        <p className="dv-demo-note">
          Local demo — edits reset on reload. Connect Supabase to save and
          collaborate.
        </p>
      )}
      <DocumentEditor
        store={store}
        presence={client ? { client, documentId } : undefined}
        session={session}
        renderPrefix={renderPrefix}
        renderLabel={renderLabel}
      />
    </>
  );
}
export async function mountDocument(
  element: Element,
  options: DocumentAppOptions & {
    // Refuse to fall back to the demo, for production builds.
    requireSupabase?: boolean;
    // Surround the editor with site-specific providers or chrome.
    wrap?: (app: ReactNode) => ReactNode;
  },
) {
  const { requireSupabase, wrap = (app) => app, ...app } = options;
  const root = createRoot(element);
  try {
    if (Boolean(app.url) !== Boolean(app.publishableKey))
      throw Error("Set both Supabase variables.");
    if (requireSupabase && !app.url)
      throw Error("Connect Supabase before deployment.");
    const live = app.url && app.publishableKey;
    // Signing in needs the server function; the demo's visitor is its admin.
    const session =
      live && app.endpoint
        ? createSession({ endpoint: app.endpoint, documentId: app.documentId })
        : undefined;
    const [initial] = await Promise.all([
      live
        ? loadDocument(
            createClient(app.url!, app.publishableKey!),
            app.documentId,
            app.schema,
            app.endpoint,
          )
        : { data: app.demoData, revision: 0 },
      session?.start(),
    ]);
    const people = Object.keys(app.config.collections).find(
      (type) => app.config.collections[type].kind === "person",
    );
    root.render(
      wrap(
        <DocumentApp
          {...app}
          initial={initial}
          session={
            session ??
            demoSession(
              app.config.admin ?? (people && app.demoData[people]?.[0]?.id),
            )
          }
        />,
      ),
    );
  } catch {
    root.render(
      <p>
        Could not load the Supabase document. Check configuration and access.
      </p>,
    );
  }
}
