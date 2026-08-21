import { createClient } from "@supabase/supabase-js";
import { CONFIG, assertSupabase } from "./config.js";

function client() {
  assertSupabase();
  return createClient(CONFIG.supabase.url, CONFIG.supabase.serviceKey, {
    auth: { persistSession: false },
  });
}

// Upload the PNG to the public bucket and return a public HTTPS URL.
// (LINE fetches image messages from a URL — it won't accept raw bytes.)
export async function hostImage(buffer, filename) {
  const sb = client();
  const { error } = await sb.storage
    .from(CONFIG.supabase.bucket)
    .upload(filename, buffer, { contentType: "image/png", upsert: true, cacheControl: "3600" });
  if (error) throw new Error(`Supabase upload failed: ${error.message}`);
  const { data } = sb.storage.from(CONFIG.supabase.bucket).getPublicUrl(filename);
  if (!data?.publicUrl) throw new Error("Could not resolve public URL");
  return `${data.publicUrl}?v=${Date.now()}`; // cache-bust
}

// Optional: write the latest brief (url + stories) to a row so OTHER systems
// (any language) can read it. Enable with PUBLISH_LATEST=1.
export async function publishLatest({ imageUrl, stories }) {
  const sb = client();
  const { error } = await sb
    .from(CONFIG.supabase.latestTable)
    .upsert(
      { id: "latest", image_url: imageUrl, stories, updated_at: new Date().toISOString() },
      { onConflict: "id" }
    );
  if (error) throw new Error(`Supabase publishLatest failed: ${error.message}`);
}
