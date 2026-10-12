import type { SupabaseClient } from "@supabase/supabase-js";
import { validate, type Config, type Data, type Snapshot } from "./model";
import { DocumentStore, type Transport } from "./store";
export async function readDocument(
  client: SupabaseClient,
  documentId: string,
): Promise<Snapshot> {
  const { data, error } = await client
    .from("dv_documents")
    .select("data,revision")
    .eq("id", documentId)
    .abortSignal(AbortSignal.timeout(15000))
    .single();
  if (error) throw error;
  return data as Snapshot;
}
// Only startup may use the last local base; network refreshes must report failures.
export async function loadDocument(
  client: SupabaseClient,
  documentId: string,
): Promise<Snapshot> {
  try {
    return await readDocument(client, documentId);
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
export function supabaseTransport(
  client: SupabaseClient,
  documentId: string,
): Transport {
  return {
    read: () => readDocument(client, documentId),
    async commit(requestId, operations) {
      const { data, error } = await client
        .rpc("dv_apply", {
          document_id: documentId,
          request_id: requestId,
          operations,
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
          const snapshot = await readDocument(client, documentId);
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
            event: "UPDATE",
            schema: "public",
            table: "dv_documents",
            filter: `id=eq.${documentId}`,
          },
          (payload) => {
            if (alive) receive(payload.new as Snapshot);
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
}) {
  return new DocumentStore(
    options.config,
    options.initial,
    supabaseTransport(options.client, options.documentId),
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
}
// Trusted setup only: call with a secret-key client from a seed script, never a browser.
// An existing document is left untouched.
export async function provisionDocument(
  client: SupabaseClient,
  options: {
    documentId: string;
    config: Config;
    data: Data;
    publicRead?: boolean;
    publicWrite?: boolean;
  },
) {
  validate(options.config, options.data);
  const { error } = await client.from("dv_documents").upsert(
    {
      id: options.documentId,
      config: options.config,
      data: options.data,
      revision: 0,
      public_read: options.publicRead ?? false,
      public_write: options.publicWrite ?? false,
    },
    { onConflict: "id", ignoreDuplicates: true },
  );
  if (error) throw error;
}
