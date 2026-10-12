// For seed scripts run with Node, never the browser: uses the secret key.
import { createClient } from "@supabase/supabase-js";
import type { Config, Data } from "./model";
import { provisionDocument } from "./supabase";
export async function seedFromEnv(options: {
  documentId: string;
  config: Config;
  data: Data;
  publicRead?: boolean;
  publicWrite?: boolean;
  schema?: string;
}) {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL,
    key =
      process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw Error("Set Supabase URL and server secret first.");
  await provisionDocument(
    createClient(url, key, { auth: { persistSession: false } }),
    options,
  );
}
