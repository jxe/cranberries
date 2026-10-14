import type { SupabaseClient } from "@supabase/supabase-js";
import { type Change, type Config, type Snapshot } from "./model";
import { DocumentStore, type Transport } from "./store";
import type { Session } from "./session";
// The tables live in `public` unless the migrations were installed into
// another schema (`npm run sql -- <schema>`), which is then passed as `schema`.
const within = (client: SupabaseClient, schema?: string) =>
  schema ? (client.schema(schema) as unknown as SupabaseClient) : client;
// Reads and writes go to the server function at `endpoint` (see server.ts).
// `session` is the token that says who is asking (see session.ts).
export async function call(
  endpoint: string,
  documentId: string,
  body?: unknown,
  session?: string,
) {
  const response = await fetch(
    `${endpoint}?document=${encodeURIComponent(documentId)}`,
    {
      signal: AbortSignal.timeout(15000),
      ...(body
        ? {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(session ? { authorization: `Bearer ${session}` } : {}),
            },
            body: JSON.stringify(body),
          }
        : {}),
    },
  );
  const result = await response.json();
  if (!response.ok)
    throw Object.assign(Error(result.message ?? "Request failed."), {
      status: response.status,
    });
  return result;
}
export async function readDocument(
  client: SupabaseClient,
  documentId: string,
  schema?: string,
  endpoint?: string,
): Promise<Snapshot> {
  if (endpoint) return call(endpoint, documentId);
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
  endpoint?: string,
): Promise<Snapshot> {
  try {
    return await readDocument(client, documentId, schema, endpoint);
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
// Writes carry the session's token; the server logs them under its person.
export function supabaseTransport(
  client: SupabaseClient,
  documentId: string,
  schema?: string,
  session?: Session,
  endpoint?: string,
): Transport {
  return {
    read: () => readDocument(client, documentId, schema, endpoint),
    async commit(requestId, operations) {
      if (endpoint)
        try {
          return await call(
            endpoint,
            documentId,
            { requestId, operations },
            session?.token(),
          );
        } catch (error) {
          // Signed out from elsewhere: the link behind this session was revoked.
          if ((error as { status?: number }).status === 401) session?.expired();
          throw error;
        }
      const { data, error } = await within(client, schema)
        .rpc("dv_apply", {
          document_id: documentId,
          request_id: requestId,
          operations,
          actor: session?.state().person ?? null,
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
          const snapshot = await readDocument(
            client,
            documentId,
            schema,
            endpoint,
          );
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
  // Who is signed in. Without one, or with nobody signed in, nothing changes.
  session?: Session;
  // The server function that reads and writes, in place of database functions.
  endpoint?: string;
}) {
  const store = new DocumentStore(
    options.config,
    options.initial,
    supabaseTransport(
      options.client,
      options.documentId,
      options.schema,
      options.session,
      options.endpoint,
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
  const { session } = options;
  store.me = () => session?.state().person;
  store.readOnly = () => !session?.state().person;
  return store;
}
