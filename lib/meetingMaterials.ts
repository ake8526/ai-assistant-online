// User-linked files/links for a calendar meeting (attached later, used in morning prep).
import { getSetting, setSetting } from "@/lib/store";

const KEY = "_meeting_materials";
const MAX_PER_EVENT = 10;
const MAX_EVENTS = 80;
const TTL_MS = 60 * 24 * 3600_000; // ~60 days

export type MeetingMaterial = {
  type: "file" | "link";
  id?: string;
  name?: string;
  url: string;
  note?: string;
  added_at: number;
};

type Store = Record<
  string,
  {
    items: MeetingMaterial[];
    updated_at: number;
    subject?: string;
  }
>;

async function loadAll(upn: string): Promise<Store> {
  try {
    const raw = await getSetting(upn, KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Store) : {};
  } catch {
    return {};
  }
}

async function saveAll(upn: string, store: Store): Promise<void> {
  const now = Date.now();
  const pruned: Store = {};
  const entries = Object.entries(store)
    .filter(([, v]) => v && Array.isArray(v.items) && v.items.length && now - (v.updated_at || 0) < TTL_MS)
    .sort((a, b) => (b[1].updated_at || 0) - (a[1].updated_at || 0))
    .slice(0, MAX_EVENTS);
  for (const [id, v] of entries) pruned[id] = v;
  await setSetting(upn, KEY, JSON.stringify(pruned));
}

export async function getMeetingMaterials(upn: string, eventId: string): Promise<MeetingMaterial[]> {
  const store = await loadAll(upn);
  return store[eventId]?.items || [];
}

export async function listMeetingMaterials(
  upn: string,
  eventId: string
): Promise<{ subject?: string; items: MeetingMaterial[] }> {
  const store = await loadAll(upn);
  const row = store[eventId];
  return { subject: row?.subject, items: row?.items || [] };
}

export async function addMeetingMaterial(
  upn: string,
  eventId: string,
  item: Omit<MeetingMaterial, "added_at"> & { added_at?: number },
  subject?: string
): Promise<MeetingMaterial[]> {
  const store = await loadAll(upn);
  const row = store[eventId] || { items: [], updated_at: Date.now(), subject };
  const next: MeetingMaterial = {
    type: item.type,
    id: item.id,
    name: item.name,
    url: item.url,
    note: item.note,
    added_at: item.added_at || Date.now(),
  };
  // de-dupe by url or drive id
  const key = (next.id || next.url || "").toLowerCase();
  row.items = row.items.filter((x) => (x.id || x.url || "").toLowerCase() !== key);
  row.items.push(next);
  if (row.items.length > MAX_PER_EVENT) row.items = row.items.slice(-MAX_PER_EVENT);
  row.updated_at = Date.now();
  if (subject) row.subject = subject;
  store[eventId] = row;
  await saveAll(upn, store);
  return row.items;
}

export async function removeMeetingMaterial(
  upn: string,
  eventId: string,
  index1: number
): Promise<{ ok: boolean; removed?: MeetingMaterial; items: MeetingMaterial[] }> {
  const store = await loadAll(upn);
  const row = store[eventId];
  if (!row?.items?.length) return { ok: false, items: [] };
  const i = index1 - 1;
  if (i < 0 || i >= row.items.length) return { ok: false, items: row.items };
  const removed = row.items.splice(i, 1)[0];
  row.updated_at = Date.now();
  if (!row.items.length) delete store[eventId];
  else store[eventId] = row;
  await saveAll(upn, store);
  return { ok: true, removed, items: row.items || [] };
}

export function formatMaterialsList(subject: string, items: MeetingMaterial[]): string {
  if (!items.length) return `ยังไม่มีไฟล์/ลิงก์ที่ผูกกับนัด “${subject}” ครับ`;
  const lines = [`📎 เอกสารที่ผูกกับนัด: ${subject}`, ""];
  items.forEach((it, i) => {
    const kind = it.type === "file" ? "ไฟล์" : "ลิงก์";
    const title = (it.name || it.url || "").trim();
    lines.push(`${i + 1}) [${kind}] ${title}`);
    if (it.name && it.url && it.url !== it.name) lines.push(`   ${it.url}`);
  });
  lines.push("", "เลิกผูก: พิมพ์ เช่น “เลิกแนบนัด 1 ไฟล์ 2”");
  return lines.join("\n");
}
