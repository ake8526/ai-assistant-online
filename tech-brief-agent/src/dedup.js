import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";
import { CONFIG, assertSupabase } from "./config.js";

export function fingerprint(story) {
  const basis = (story.url || story.headline_th || "").split("?")[0].toLowerCase().trim();
  return crypto.createHash("sha256").update(basis).digest("hex").slice(0, 40);
}

function client() {
  assertSupabase();
  return createClient(CONFIG.supabase.url, CONFIG.supabase.serviceKey, {
    auth: { persistSession: false },
  });
}

// Stories already sent within the rolling window (feed to the agent).
export async function getDedupRecent() {
  const since = new Date(Date.now() - CONFIG.supabase.dedupWindowDays * 86_400_000).toISOString();
  const { data, error } = await client()
    .from(CONFIG.supabase.dedupTable)
    .select("fingerprint,title,url,sent_at")
    .gte("sent_at", since)
    .order("sent_at", { ascending: false });
  if (error) throw new Error(`Supabase dedup read failed: ${error.message}`);
  return data || [];
}

// Record what was sent so it won't repeat tomorrow.
export async function saveDedup(stories) {
  const rows = stories.map((s) => ({ fingerprint: fingerprint(s), title: s.headline_th, url: s.url }));
  const { error } = await client()
    .from(CONFIG.supabase.dedupTable)
    .upsert(rows, { onConflict: "fingerprint" });
  if (error) throw new Error(`Supabase dedup write failed: ${error.message}`);
}
