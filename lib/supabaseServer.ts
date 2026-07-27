import { createClient } from "@supabase/supabase-js";

// Server-only Supabase client using the SECRET (service_role) key.
// RLS is ON with no policies, so only this key can read/write — never expose it
// to the browser (no NEXT_PUBLIC_ prefix).
const url = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const serviceKey = process.env.SUPABASE_SERVICE_KEY || "";

export const admin = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

export function assertConfigured() {
  if (!url || !serviceKey) {
    throw new Error("Supabase not configured: set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_KEY");
  }
}
