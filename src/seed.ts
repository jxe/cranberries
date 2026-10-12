// For seed scripts run with Node, never the browser: uses the secret key.
import { createClient } from "@supabase/supabase-js";
import type { Config, Data } from "./model";
import { provisionDocument, syncDocument } from "./supabase";
function secretClient() {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL,
    key =
      process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw Error("Set Supabase URL and server secret first.");
  return createClient(url, key, { auth: { persistSession: false } });
}
// Creates the document if it does not exist; otherwise brings its stored config
// up to date with the one in code and leaves its records alone.
export async function seedFromEnv(options: {
  documentId: string;
  config: Config;
  data: Data;
  publicRead?: boolean;
  publicWrite?: boolean;
  schema?: string;
  adaptor?: string;
}) {
  const client = secretClient();
  await provisionDocument(client, options);
  await syncDocument(client, options);
}
