import { createClient } from "@supabase/supabase-js";

// Server-only Supabase client using the SECRET (service_role) key.
// RLS is ON with no policies, so only this key can read/write — never expose it
// to the browser (no NEXT_PUBLIC_ prefix).
// Fallback placeholders so createClient() never throws at import/build time when
// env vars aren't present yet (e.g. before Vercel env is set). Real requests call
// assertConfigured() first, which throws a clear error if config is actually missing.
const url = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://placeholder.supabase.co";
const serviceKey = process.env.SUPABASE_SERVICE_KEY || "placeholder-service-key";

export const admin = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

export function assertConfigured() {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    throw new Error("Supabase not configured: set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_KEY");
  }
}
