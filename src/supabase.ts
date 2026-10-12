import type { SupabaseClient } from "@supabase/supabase-js";
import {
  validate,
  type Change,
  type Config,
  type Data,
  type Snapshot,
} from "./model";
import { DocumentStore, type Transport } from "./store";
// The tables live in `public` unless the migrations were installed into
// another schema (`npm run sql -- <schema>`), which is then passed as `schema`.
const within = (client: SupabaseClient, schema?: string) =>
  schema ? (client.schema(schema) as unknown as SupabaseClient) : client;
export async function readDocument(
  client: SupabaseClient,
  documentId: string,
  schema?: string,
): Promise<Snapshot> {
  const { data, error } = await within(client, schema)
    .rpc("dv_read", { document_id: documentId })
    .abortSignal(AbortSignal.timeout(15000));
  if (error) throw error;
  return data as Snapshot;
}
// Only startup may use the last local base; network refreshes must report failures.
export async function loadDocument(
  client: SupabaseClient,
  documentId: string,
  schema?: string,
): Promise<Snapshot> {
  try {
    return await readDocument(client, documentId, schema);
  } catch (error) {
    try {
      const saved = sessionStorage.getItem(
        `dv-draft:${client.realtime.endPoint}:${documentId}`,
      );
      if (saved) {
        const draft = JSON.parse(saved);
        if (draft.version === 1 && draft.queue?.length && draft.base)
          return draft.base;
      }
    } catch {
      /* Preserve the original network error. */
    }
    throw error;
  }
}
// `actor` names the person making the writes, for the change log.
export function supabaseTransport(
  client: SupabaseClient,
  documentId: string,
  schema?: string,
  actor?: () => string | undefined,
): Transport {
  return {
    read: () => readDocument(client, documentId, schema),
    async commit(requestId, operations) {
      const { data, error } = await within(client, schema)
        .rpc("dv_apply", {
          document_id: documentId,
          request_id: requestId,
          operations,
          actor: actor?.() ?? null,
        })
        .abortSignal(AbortSignal.timeout(15000));
      if (error) throw error;
      return data;
    },
    subscribe(receive, status) {
      let alive = true;
      let refreshing = false;
      const recover = async () => {
        if (!alive || refreshing) return;
        refreshing = true;
        try {
          if (!client.realtime.isConnected()) client.realtime.connect();
          const snapshot = await readDocument(client, documentId, schema);
          if (alive) receive(snapshot);
        } catch {
          /* Writes have their own retry and error reporting. */
        } finally {
          refreshing = false;
        }
      };
      const wake = () => {
        if (!document.hidden) void recover();
      };
      const browser = typeof window !== "undefined";
      const timer = browser ? setInterval(wake, 30000) : undefined;
      const previousHeartbeat = browser
        ? client.realtime.heartbeatCallback
        : undefined;
      if (browser) {
        client.realtime.onHeartbeat((event, latency) => {
          previousHeartbeat?.(event, latency);
          if (!alive) return;
          if (
            event === "timeout" ||
            event === "error" ||
            event === "disconnected"
          ) {
            status(false);
            void recover();
          }
        });
        window.addEventListener("online", wake);
        window.addEventListener("focus", wake);
        document.addEventListener("visibilitychange", wake);
      }
      const channel = client
        .channel(`document:${documentId}:${crypto.randomUUID()}`)
        .on(
          "postgres_changes",
          {
            event: "INSERT",
            schema: schema ?? "public",
            table: "dv_changes",
            filter: `document_id=eq.${documentId}`,
          },
          (payload) => {
            if (alive) receive(payload.new as Change);
          },
        )
        .subscribe((s) => {
          if (alive) status(s === "SUBSCRIBED");
        });
      return () => {
        alive = false;
        clearInterval(timer);
        if (browser) {
          client.realtime.onHeartbeat(previousHeartbeat ?? (() => {}));
          window.removeEventListener("online", wake);
          window.removeEventListener("focus", wake);
          document.removeEventListener("visibilitychange", wake);
        }
        void client.removeChannel(channel);
      };
    },
  };
}
export function createSupabaseDocument(options: {
  client: SupabaseClient;
  documentId: string;
  config: Config;
  initial: Snapshot;
  schema?: string;
  actor?: () => string | undefined;
}) {
  const store = new DocumentStore(
    options.config,
    options.initial,
    supabaseTransport(
      options.client,
      options.documentId,
      options.schema,
      options.actor,
    ),
    typeof window === "undefined"
      ? undefined
      : {
          load: () =>
            sessionStorage.getItem(
              `dv-draft:${options.client.realtime.endPoint}:${options.documentId}`,
            ),
          save: (value) =>
            sessionStorage.setItem(
              `dv-draft:${options.client.realtime.endPoint}:${options.documentId}`,
              value,
            ),
          clear: () =>
            sessionStorage.removeItem(
              `dv-draft:${options.client.realtime.endPoint}:${options.documentId}`,
            ),
        },
  );
  if (options.actor) store.me = options.actor;
  return store;
}
// Trusted setup only: call with a secret-key client from a seed script, never a browser.
// An existing document is left untouched. Records go to the triple store unless
// another storage adaptor is named.
export async function provisionDocument(
  client: SupabaseClient,
  options: {
    documentId: string;
    config: Config;
    data: Data;
    publicRead?: boolean;
    publicWrite?: boolean;
    schema?: string;
    adaptor?: string;
  },
) {
  validate(options.config, options.data);
  const { error } = await within(client, options.schema).rpc("dv_provision", {
    document_id: options.documentId,
    config: options.config,
    data: options.data,
    public_read: options.publicRead ?? false,
    public_write: options.publicWrite ?? false,
    adaptor: options.adaptor ?? "triples",
  });
  if (error) throw error;
}
// Trusted setup only. Makes the stored config match the one in code, so writes
// are checked against it. Refused if the document's records do not fit it.
export async function syncDocument(
  client: SupabaseClient,
  options: { documentId: string; config: Config; schema?: string },
) {
  const { error } = await within(client, options.schema).rpc("dv_configure", {
    document_id: options.documentId,
    config: options.config,
  });
  if (error) throw error;
}
