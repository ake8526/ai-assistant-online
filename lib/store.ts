// Supabase-backed storage helpers — ported from morning_brief/storage.py
// (tasks, settings, places, seen_meetings). Feeds/consents/line_links already
// have their own routes; line link lookups live in lib/line.ts.
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

export async function allSettings(ownerUpn: string): Promise<Record<string, string>> {
  const { data } = await admin.from("settings").select("key,value").eq("owner_upn", ownerUpn);
  const out: Record<string, string> = {};
  for (const r of data || []) out[r.key] = r.value;
  return out;
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
  makePrimary = false
): Promise<number> {
  const { data, error } = await admin
    .from("places")
    .insert({ owner_upn: ownerUpn, category, label, location })
    .select("id")
    .single();
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
