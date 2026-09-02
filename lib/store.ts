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

/**
 * ลบงานทิ้งถาวร — ใช้จากหน้าจัดการเท่านั้น
 *
 * จำกัดด้วย owner_upn เสมอ ไม่ใช่แค่ id: หน้าเว็บส่ง id มาเป็นชุด พลาดครั้งเดียว
 * แล้วลบของคนอื่นไปด้วยจะไม่มีอะไรมาดักไว้เลย
 */
export async function deleteTasks(ownerUpn: string, ids: number[]): Promise<number> {
  const clean = ids.filter((n) => Number.isInteger(n) && n > 0);
  if (!clean.length) return 0;
  const { data, error } = await admin
    .from("tasks")
    .delete()
    .eq("owner_upn", ownerUpn.toLowerCase())
    .in("id", clean)
    .select("id");
  if (error) throw new Error(`deleteTasks: ${error.message}`);
  return (data || []).length;
}

/** เลื่อนกำหนดส่งของงานหนึ่ง — ใช้ตอนผู้ใช้สั่งแก้เวลาจากไลน์ */
export async function updateTaskDue(taskId: number, dueIso: string | null): Promise<boolean> {
  const { data, error } = await admin
    .from("tasks")
    .update({ due: dueIso })
    .eq("id", taskId)
    .select("id");
  if (error) throw new Error(`updateTaskDue: ${error.message}`);
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

/** Pending tasks due within the next `withinMs` (still in the future). */
export async function upcomingDueTasks(withinMs: number): Promise<Task[]> {
  const now = Date.now();
  const until = new Date(now + Math.max(0, withinMs)).toISOString();
  const { data, error } = await admin
    .from("tasks")
    .select("*")
    .eq("status", "pending")
    .not("due", "is", null)
    .gt("due", new Date(now).toISOString())
    .lte("due", until);
  if (error) throw new Error(`upcomingDueTasks: ${error.message}`);
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
// Seen meetings — the recurring summary job summarizes each meeting once.
//
// History worth keeping: this lived in a `seen_meetings` table whose migration
// was never applied, so every write failed silently and every run re-sent the
// same summary. Moving it into `settings` fixed the writes but kept the whole
// set in ONE json row — and that row is read-modify-written by several users'
// runs (and by overlapping cron invocations) at once, so each write dropped the
// keys the others had just added. On 13 Aug the same meeting went out four
// times to three people, and the store held two keys in total.
//
// Now: one row per meeting (`seen_mt_<digest>`), so two runs can never clobber
// each other's record. Rows are small and bounded by their own TTL sweep.
// ---------------------------------------------------------------------------
const OPS_BUCKET = "_ops";
const SEEN_MEETINGS_KEY = "seen_meetings"; // legacy json blob — migrated on first use
const SEEN_MEETINGS_READY = "seen_meetings_ready";
const SEEN_MT_PREFIX = "seen_mt_";
const SEEN_MEETINGS_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/** Meeting keys can be long (join-url hashes); store a short digest. */
function meetingKey(eventId: string): string {
  return createHash("sha1").update(eventId, "utf8").digest("hex").slice(0, 16);
}

const seenRow = (eventId: string) => `${SEEN_MT_PREFIX}${meetingKey(eventId)}`;

/** Copy the old json blob into per-meeting rows once, then mark the store ready.
 *  Idempotent: safe to call on every run, does nothing once the flag is set. */
async function migrateLegacySeenMeetings(): Promise<void> {
  if (await getSetting(OPS_BUCKET, SEEN_MEETINGS_READY)) return;
  const raw = await getSetting(OPS_BUCKET, SEEN_MEETINGS_KEY);
  if (raw) {
    try {
      const entries = JSON.parse(raw) as [string, number][];
      if (Array.isArray(entries)) {
        for (const [key, ts] of entries) {
          if (typeof key !== "string" || !key) continue;
          // Legacy keys are already digests — keep them exactly as they were,
          // or the meetings they cover would look unseen and be re-sent.
          await setSetting(OPS_BUCKET, `${SEEN_MT_PREFIX}${key}`, String(ts || Date.now()));
        }
        await setSetting(OPS_BUCKET, SEEN_MEETINGS_READY, "1");
        return;
      }
    } catch {
      /* fall through — an unreadable blob is not worth blocking on */
    }
  }
}

/** False before anything has ever been recorded — the caller should seed the
 *  lookback window rather than treat a whole day of meetings as brand new. */
export async function seenMeetingsReady(): Promise<boolean> {
  await migrateLegacySeenMeetings();
  return !!(await getSetting(OPS_BUCKET, SEEN_MEETINGS_READY));
}

/** Record keys without summarizing (first run after install/repair). */
export async function seedMeetingsSeen(eventIds: string[]): Promise<void> {
  const now = String(Date.now());
  for (const id of eventIds) {
    if (id) await setSetting(OPS_BUCKET, seenRow(id), now);
  }
  await setSetting(OPS_BUCKET, SEEN_MEETINGS_READY, "1");
}

export async function wasMeetingSummarized(eventId: string): Promise<boolean> {
  if (!eventId) return false;
  await migrateLegacySeenMeetings();
  const raw = await getSetting(OPS_BUCKET, seenRow(eventId));
  if (!raw) return false;
  const ts = parseInt(raw, 10);
  if (Number.isFinite(ts) && Date.now() - ts > SEEN_MEETINGS_TTL_MS) return false; // aged out
  return true;
}

/**
 * Claim a meeting BEFORE the summary is built and sent. Returns false when
 * someone else already holds it, which is what stops two overlapping runs from
 * both delivering. Release with `releaseMeetingSummary` if the work then fails.
 */
export async function claimMeetingSummary(eventId: string): Promise<boolean> {
  if (!eventId) return false;
  if (await wasMeetingSummarized(eventId)) return false;
  await setSetting(OPS_BUCKET, seenRow(eventId), String(Date.now()));
  await setSetting(OPS_BUCKET, SEEN_MEETINGS_READY, "1");
  return true;
}

/** Hand a claim back when the summary could not be produced or delivered. */
export async function releaseMeetingSummary(eventId: string): Promise<void> {
  if (!eventId) return;
  await setSetting(OPS_BUCKET, seenRow(eventId), "");
}

/**
 * Last line of defence: even if a summary is somehow produced twice, the same
 * person must not receive the same meeting's summary twice. Keyed per recipient
 * so one person's row can never overwrite another's.
 */
const DELIVERED_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export async function alreadyGotSummary(upn: string, meetingKeyRaw: string): Promise<boolean> {
  if (!upn || !meetingKeyRaw) return false;
  const raw = await getSetting(upn, `sm_dlv_${meetingKey(meetingKeyRaw)}`);
  if (!raw) return false;
  const ts = parseInt(raw, 10);
  return !(Number.isFinite(ts) && Date.now() - ts > DELIVERED_TTL_MS);
}

export async function noteSummaryDelivered(upn: string, meetingKeyRaw: string): Promise<void> {
  if (!upn || !meetingKeyRaw) return;
  await setSetting(upn, `sm_dlv_${meetingKey(meetingKeyRaw)}`, String(Date.now()));
}

export async function markMeetingSummarized(eventId: string, ownerUpn = "", subject = ""): Promise<void> {
  void ownerUpn;
  void subject;
  if (!eventId) return;
  // setSetting throws on failure — losing the dedupe silently is what caused
  // the same summary to be pushed over and over.
  await setSetting(OPS_BUCKET, seenRow(eventId), String(Date.now()));
  await setSetting(OPS_BUCKET, SEEN_MEETINGS_READY, "1");
}

// ---------------------------------------------------------------------------
// Chat Logging for LLM Fine-tuning Dataset
// ---------------------------------------------------------------------------

export type ChatLogEntry = {
  id?: string;
  session_id: string;
  user_upn?: string | null;
  channel: "line" | "web" | "system" | string;
  role: "user" | "assistant" | "system";
  content: string;
  metadata?: Record<string, unknown>;
  created_at?: string;
};

/** Log a single turn (user question or assistant reply) to chat_logs table for LLM training */
export async function logChatTurn(entry: ChatLogEntry): Promise<void> {
  if (!entry.content || !entry.content.trim()) return;
  try {
    const { error } = await admin.from("chat_logs").insert({
      session_id: entry.session_id,
      user_upn: entry.user_upn || null,
      channel: entry.channel || "line",
      role: entry.role,
      content: entry.content.trim(),
      metadata: entry.metadata || {},
    });
    if (error) {
      console.error("[chat_logs] logChatTurn error:", error.message);
    }
  } catch (err) {
    console.error("[chat_logs] failed to save turn:", String(err).slice(0, 150));
  }
}

/** Export chat logs grouped by session in OpenAI JSONL fine-tuning format */
export async function exportChatLogsJsonl(options?: {
  limitSessions?: number;
  startDate?: string;
}): Promise<string> {
  let query = admin
    .from("chat_logs")
    .select("session_id, role, content, created_at, user_upn")
    .order("created_at", { ascending: true });

  if (options?.startDate) {
    query = query.gte("created_at", options.startDate);
  }

  const { data, error } = await query;
  if (error) throw new Error(`exportChatLogsJsonl: ${error.message}`);
  if (!data || data.length === 0) return "";

  // Group messages by session_id
  const sessions = new Map<string, Array<{ role: string; content: string }>>();
  for (const row of data) {
    if (!sessions.has(row.session_id)) {
      sessions.set(row.session_id, []);
    }
    const role = row.role === "assistant" ? "assistant" : row.role === "system" ? "system" : "user";
    sessions.get(row.session_id)!.push({ role, content: row.content });
  }

  const systemMsg = {
    role: "system",
    content: "คุณคือ AI Assistant ผู้ช่วยงานอัจฉริยะที่คอยตอบคำถามและจัดการนัดหมายอย่างสุภาพและถูกต้อง",
  };

  const jsonlLines: string[] = [];
  let count = 0;
  for (const [, messages] of sessions.entries()) {
    if (options?.limitSessions && count >= options.limitSessions) break;
    // Only export sessions with at least one user-assistant pair
    if (messages.some((m) => m.role === "user") && messages.some((m) => m.role === "assistant")) {
      const fullMessages = [systemMsg, ...messages];
      jsonlLines.push(JSON.stringify({ messages: fullMessages }));
      count++;
    }
  }

  return jsonlLines.join("\n");
}

