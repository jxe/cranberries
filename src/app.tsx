// Startup glue shared by sites: connect to Supabase when configured, otherwise
// run an in-memory demo. Knows React and the browser, not a bundler or router.
import { useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { createClient } from "@supabase/supabase-js";
import type { Config, Data, Snapshot } from "./model";
import { createMemoryDocument } from "./memory";
import { createSupabaseDocument, loadDocument } from "./supabase";
import { DocumentEditor, type DocumentEditorProps } from "./react";
import { createIdentity } from "./identity";
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
}: DocumentAppOptions & { initial: Snapshot }) {
  const [client] = useState(() =>
    url && publishableKey
      ? createClient(url, publishableKey, {
          realtime: { worker: typeof Worker !== "undefined" },
        })
      : null,
  );
  const [identity] = useState(() => createIdentity(documentId));
  const [store] = useState(() => {
    const store = client
      ? createSupabaseDocument({
          client,
          documentId,
          config,
          initial,
          schema,
          endpoint,
          actor: identity.get,
        })
      : createMemoryDocument(config, initial);
    store.me = identity.get;
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
        identity={identity}
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
    const initial =
      app.url && app.publishableKey
        ? await loadDocument(
            createClient(app.url, app.publishableKey),
            app.documentId,
            app.schema,
            app.endpoint,
          )
        : { data: app.demoData, revision: 0 };
    root.render(wrap(<DocumentApp {...app} initial={initial} />));
  } catch {
    root.render(
      <p>
        Could not load the Supabase document. Check configuration and access.
      </p>,
    );
  }
}
