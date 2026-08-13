// Supabase-backed storage helpers — ported from morning_brief/storage.py
// (tasks, settings, places, seen_meetings). Feeds/consents/line_links already
// have their own routes; line link lookups live in lib/line.ts.
import { createHash } from "crypto";
import { admin } from "@/lib/supabaseServer";

export type Task = {
  id: number;
  owner_upn: string;
  title: string;
  detail: string | null;
  responsible: string | null;
  responsible_upn: string | null;
  due: string | null; // UTC ISO
  status: string;
  source: string | null;
  dedup_key: string | null;
  created_at: string;
  reminded_at: string | null;
};

export async function addTask(t: {
  owner_upn: string;
  title: string;
  detail?: string;
  responsible?: string;
  responsible_upn?: string | null;
  due?: string | null;
  source?: string;
  dedup_key?: string | null;
}): Promise<number | null> {
  const { data, error } = await admin
    .from("tasks")
    .insert({
      owner_upn: t.owner_upn,
      title: t.title,
      detail: t.detail || "",
      responsible: t.responsible || "",
      responsible_upn: t.responsible_upn || null,
      due: t.due || null,
      status: "pending",
      source: t.source || "",
      dedup_key: t.dedup_key || null,
    })
    .select("id")
    .single();
  if (error) {
    if (error.code === "23505") return null; // duplicate dedup_key — already tracked
    throw new Error(`addTask: ${error.message}`);
  }
  return data?.id ?? null;
}

export async function listTasks(ownerUpn?: string, status?: string): Promise<Task[]> {
  let q = admin.from("tasks").select("*");
  if (ownerUpn) q = q.eq("owner_upn", ownerUpn);
  if (status) q = q.eq("status", status);
  const { data, error } = await q
    .order("due", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: false });
  if (error) throw new Error(`listTasks: ${error.message}`);
  return data || [];
}

export async function updateTaskStatus(taskId: number, status: string): Promise<boolean> {
  const { data, error } = await admin.from("tasks").update({ status }).eq("id", taskId).select("id");
  if (error) throw new Error(`updateTaskStatus: ${error.message}`);
  return (data || []).length > 0;
}

export async function markReminded(taskId: number): Promise<void> {
  await admin.from("tasks").update({ reminded_at: new Date().toISOString() }).eq("id", taskId);
}

/** Pending tasks whose due time has passed. */
export async function duePendingTasks(): Promise<Task[]> {
  const { data, error } = await admin
    .from("tasks")
    .select("*")
    .eq("status", "pending")
    .not("due", "is", null)
    .lte("due", new Date().toISOString());
  if (error) throw new Error(`duePendingTasks: ${error.message}`);
  return data || [];
}

// ---------------------------------------------------------------------------
// Settings (per-user key/value)
// ---------------------------------------------------------------------------
export async function getSetting(ownerUpn: string, key: string): Promise<string | null> {
  const { data } = await admin
    .from("settings")
    .select("value")
    .eq("owner_upn", ownerUpn)
    .eq("key", key)
    .maybeSingle();
  return data?.value ?? null;
}

export async function setSetting(ownerUpn: string, key: string, value: string): Promise<void> {
  const { error } = await admin
    .from("settings")
    .upsert({ owner_upn: ownerUpn, key, value }, { onConflict: "owner_upn,key" });
  if (error) throw new Error(`setSetting: ${error.message}`);
}

export async function deleteSetting(ownerUpn: string, key: string): Promise<void> {
  await admin.from("settings").delete().eq("owner_upn", ownerUpn).eq("key", key);
}

/** Selected settings for several users in ONE query — used by the schedule checks
 *  that run every minute, where a read per key per user adds up. Avoids pulling
 *  the big cached payload rows that allSettings() would. */
export async function getSettingsFor(
  ownerUpns: string[],
  keys: string[]
): Promise<Record<string, Record<string, string>>> {
  const out: Record<string, Record<string, string>> = {};
  for (const u of ownerUpns) out[u] = {};
  if (!ownerUpns.length || !keys.length) return out;
  const { data } = await admin
    .from("settings")
    .select("owner_upn,key,value")
    .in("owner_upn", ownerUpns)
    .in("key", keys);
  for (const r of data || []) {
    if (!out[r.owner_upn]) out[r.owner_upn] = {};
    out[r.owner_upn][r.key] = r.value;
  }
  return out;
}

export async function allSettings(ownerUpn: string): Promise<Record<string, string>> {
  const { data } = await admin.from("settings").select("key,value").eq("owner_upn", ownerUpn);
  const out: Record<string, string> = {};
  for (const r of data || []) out[r.key] = r.value;
  return out;
}

// ---------------------------------------------------------------------------
// Seen news stories — skip already-summarized links on the next digest
// ---------------------------------------------------------------------------
const NEWS_SEEN_KEY = "news_seen";
const NEWS_SEEN_MAX = 400;
const NEWS_SEEN_DAYS = 21;

export function newsStoryKey(link: string, title = ""): string {
  const raw = (link || title || "").trim().toLowerCase();
  if (!raw) return "";
  return createHash("sha1").update(raw, "utf8").digest("hex");
}

/** Story keys the user already received in a digest (last ~3 weeks). */
export async function loadSeenNewsKeys(ownerUpn: string): Promise<Set<string>> {
  const raw = await getSetting(ownerUpn, NEWS_SEEN_KEY);
  if (!raw) return new Set();
  try {
    const parsed = JSON.parse(raw) as { k: string; t: number }[] | string[];
    const cutoff = Date.now() - NEWS_SEEN_DAYS * 24 * 60 * 60_000;
    const keys = new Set<string>();
    if (Array.isArray(parsed) && parsed.length && typeof parsed[0] === "string") {
      for (const k of parsed as string[]) if (k) keys.add(k);
      return keys;
    }
    for (const row of parsed as { k: string; t: number }[]) {
      if (!row?.k) continue;
      if (typeof row.t === "number" && row.t < cutoff) continue;
      keys.add(row.k);
    }
    return keys;
  } catch {
    return new Set();
  }
}

/** Remember stories after they were summarized / pushed to the user. */
export async function markNewsStoriesSeen(
  ownerUpn: string,
  stories: { rawLink?: string; shortLink?: string; title?: string; id?: string }[]
): Promise<void> {
  if (!ownerUpn || !stories?.length) return;
  const now = Date.now();
  const cutoff = now - NEWS_SEEN_DAYS * 24 * 60 * 60_000;
  const byKey = new Map<string, number>();

  const raw = await getSetting(ownerUpn, NEWS_SEEN_KEY);
  try {
    const parsed = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) {
      for (const row of parsed) {
        if (typeof row === "string" && row) {
          byKey.set(row, now);
          continue;
        }
        if (row?.k && typeof row.t === "number" && row.t >= cutoff) byKey.set(row.k, row.t);
      }
    }
  } catch {
    /* rebuild from new stories only */
  }

  for (const s of stories) {
    const k = newsStoryKey(s.rawLink || s.shortLink || "", s.title || "") || String(s.id || "");
    if (k) byKey.set(k, now);
  }

  const rows = [...byKey.entries()]
    .map(([k, t]) => ({ k, t }))
    .sort((a, b) => b.t - a.t)
    .slice(0, NEWS_SEEN_MAX);
  await setSetting(ownerUpn, NEWS_SEEN_KEY, JSON.stringify(rows));
}

// ---------------------------------------------------------------------------
// Places (work / home / customer)
// ---------------------------------------------------------------------------
export type Place = {
  id: number;
  owner_upn: string;
  category: string;
  label: string;
  location: string | null;
  lat: string | null;
  lng: string | null;
  is_primary: boolean;
  visit_count: number;
};

export async function addPlace(
  ownerUpn: string,
  category: string,
  label: string,
  location = "",
  makePrimary = false,
  coords?: { lat?: string | number | null; lng?: string | number | null }
): Promise<number> {
  const row: Record<string, unknown> = { owner_upn: ownerUpn, category, label, location };
  if (coords?.lat != null && coords?.lng != null && String(coords.lat) && String(coords.lng)) {
    row.lat = String(coords.lat);
    row.lng = String(coords.lng);
  }
  const { data, error } = await admin.from("places").insert(row).select("id").single();
  if (error || !data) throw new Error(`addPlace: ${error?.message}`);
  const { count } = await admin
    .from("places")
    .select("id", { count: "exact", head: true })
    .eq("owner_upn", ownerUpn)
    .eq("category", category)
    .eq("is_primary", true);
  if (makePrimary || !count) await setPrimaryPlace(ownerUpn, category, data.id);
  return data.id;
}

export async function listPlaces(ownerUpn: string, category?: string): Promise<Place[]> {
  let q = admin.from("places").select("*").eq("owner_upn", ownerUpn);
  if (category) q = q.eq("category", category);
  const { data } = await q
    .order("category")
    .order("is_primary", { ascending: false })
    .order("visit_count", { ascending: false })
    .order("id");
  return data || [];
}

export async function deletePlace(placeId: number): Promise<void> {
  await admin.from("places").delete().eq("id", placeId);
}

export async function setPrimaryPlace(ownerUpn: string, category: string, placeId: number): Promise<void> {
  await admin.from("places").update({ is_primary: false }).eq("owner_upn", ownerUpn).eq("category", category);
  await admin.from("places").update({ is_primary: true }).eq("id", placeId);
}

export async function incrementVisit(placeId: number): Promise<void> {
  const { data } = await admin.from("places").select("visit_count").eq("id", placeId).maybeSingle();
  await admin
    .from("places")
    .update({ visit_count: (data?.visit_count || 0) + 1 })
    .eq("id", placeId);
}

/** Primary place for a category; falls back to most-visited, then first. */
export async function getPrimaryPlace(ownerUpn: string, category: string): Promise<Place | null> {
  const { data } = await admin
    .from("places")
    .select("*")
    .eq("owner_upn", ownerUpn)
    .eq("category", category)
    .order("is_primary", { ascending: false })
    .order("visit_count", { ascending: false })
    .order("id")
    .limit(1)
    .maybeSingle();
  return data || null;
}

const PENDING_LINE_LOCATION_KEY = "pending_line_location";

export type PendingLineLocation = {
  title?: string;
  address?: string;
  lat: number;
  lng: number;
  at: number;
};

export async function savePendingLineLocation(
  ownerUpn: string,
  loc: Omit<PendingLineLocation, "at">
): Promise<void> {
  await setSetting(
    ownerUpn,
    PENDING_LINE_LOCATION_KEY,
    JSON.stringify({ ...loc, at: Date.now() } satisfies PendingLineLocation)
  );
}

export async function loadPendingLineLocation(ownerUpn: string): Promise<PendingLineLocation | null> {
  const raw = await getSetting(ownerUpn, PENDING_LINE_LOCATION_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as PendingLineLocation;
    if (!parsed || typeof parsed.lat !== "number" || typeof parsed.lng !== "number") return null;
    // Expire after 2 hours
    if (parsed.at && Date.now() - parsed.at > 2 * 60 * 60 * 1000) {
      await deleteSetting(ownerUpn, PENDING_LINE_LOCATION_KEY);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function clearPendingLineLocation(ownerUpn: string): Promise<void> {
  try {
    await deleteSetting(ownerUpn, PENDING_LINE_LOCATION_KEY);
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Seen meetings — the 15-min summary job summarizes each meeting once
// ---------------------------------------------------------------------------
export async function wasMeetingSummarized(eventId: string): Promise<boolean> {
  if (!eventId) return false;
  const { data } = await admin.from("seen_meetings").select("event_id").eq("event_id", eventId).maybeSingle();
  return !!data;
}

export async function markMeetingSummarized(eventId: string, ownerUpn = "", subject = ""): Promise<void> {
  if (!eventId) return;
  await admin
    .from("seen_meetings")
    .upsert({ event_id: eventId, owner_upn: ownerUpn, subject }, { onConflict: "event_id", ignoreDuplicates: true });
}
