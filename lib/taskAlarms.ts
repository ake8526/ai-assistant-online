/**
 * เตือนงานตามเวลาที่เจ้าตัวสั่งไว้เอง — ได้หลายรอบต่อหนึ่งงาน
 *
 * ตาราง tasks มีช่องเวลาเดียว (`due`) ซึ่งพอสำหรับ "เลยกำหนดแล้วเตือน" แต่ไม่พอ
 * สำหรับ "เตือนสองรอบ 16:00 กับ 17:00" ที่ผู้ใช้ขอ และ migration บน Supabase
 * ยังค้างอยู่หลายตัว จึงเก็บไว้ใน settings ไม่เพิ่มคอลัมน์
 *
 * รูปแบบ: settings(owner_upn, "task_alarms") = { "<taskId>": [{at, sent}] }
 *
 * `sent` ต้องบันทึกทีละรอบ ไม่ใช่ทั้งงาน — งานเดียวมีหลายรอบ ถ้าจำแค่ว่า
 * "เตือนงานนี้ไปแล้ว" รอบที่สองจะหายไปเงียบ ๆ
 */

import { getSetting, listTasks, setSetting } from "@/lib/store";
import { admin } from "@/lib/supabaseServer";

const KEY = "task_alarms";
/** เก็บรอบที่ผ่านไปแล้วไว้เท่านี้ เพื่อให้ยังตอบได้ว่าเตือนไปเมื่อไร */
const KEEP_MS = 7 * 24 * 3600_000;
/** กันข้อมูลบวม — คนหนึ่งตั้งได้กี่งานพร้อมกัน */
const MAX_TASKS = 60;

export type Alarm = { at: string; sent?: boolean };
export type AlarmMap = Record<string, Alarm[]>;

function parse(raw: string | null): AlarmMap {
  if (!raw) return {};
  try {
    const m = JSON.parse(raw) as AlarmMap;
    return m && typeof m === "object" ? m : {};
  } catch {
    return {};
  }
}

export async function loadAlarms(upn: string): Promise<AlarmMap> {
  return parse(await getSetting(upn.toLowerCase(), KEY));
}

async function save(upn: string, map: AlarmMap): Promise<void> {
  /* ทิ้งรอบที่ส่งไปนานแล้ว และงานที่ไม่มีรอบเหลือ — ไม่งั้นค่านี้โตขึ้นเรื่อย ๆ
     โดยไม่มีใครไปลบ */
  const cutoff = Date.now() - KEEP_MS;
  const out: AlarmMap = {};
  for (const [id, list] of Object.entries(map)) {
    const keep = (list || []).filter((a) => {
      const t = new Date(a.at).getTime();
      return Number.isFinite(t) && (!a.sent || t >= cutoff);
    });
    if (keep.length) out[id] = keep.sort((a, b) => a.at.localeCompare(b.at));
  }
  const ids = Object.keys(out)
    .sort((a, b) => Number(b) - Number(a))
    .slice(0, MAX_TASKS);
  const trimmed: AlarmMap = {};
  for (const id of ids) trimmed[id] = out[id];
  await setSetting(upn.toLowerCase(), KEY, JSON.stringify(trimmed));
}

/** ตั้งรอบเตือนของงานหนึ่งใหม่ทั้งชุด (ทับของเดิม) */
export async function setAlarms(upn: string, taskId: number, times: string[]): Promise<void> {
  const map = await loadAlarms(upn);
  const uniq = [...new Set(times)].sort();
  if (uniq.length) map[String(taskId)] = uniq.map((at) => ({ at }));
  else delete map[String(taskId)];
  await save(upn, map);
}

export async function clearAlarms(upn: string, taskId: number): Promise<void> {
  const map = await loadAlarms(upn);
  delete map[String(taskId)];
  await save(upn, map);
}

/** รอบที่ยังไม่ถึงเวลา เรียงจากใกล้สุด — ใช้ตอบผู้ใช้ว่าจะเตือนเมื่อไร */
export function upcoming(list: Alarm[] | undefined): Alarm[] {
  const now = Date.now();
  return (list || []).filter((a) => !a.sent && new Date(a.at).getTime() > now);
}

export type DueAlarm = { upn: string; taskId: number; at: string };

/**
 * รอบที่ถึงเวลาแล้วแต่ยังไม่ได้ส่ง ของทุกคน
 *
 * เผื่อไว้ 1 นาทีข้างหน้า เพราะ cron เดินทุกนาที ไม่ใช่ทุกวินาที — ไม่เผื่อแล้ว
 * รอบ 16:00 จะไปถึงตอน 16:00:59 ซึ่งอ่านดูเหมือนสาย
 */
export async function dueAlarms(): Promise<DueAlarm[]> {
  const { data } = await admin.from("settings").select("owner_upn,value").eq("key", KEY);
  const limit = Date.now() + 60_000;
  const out: DueAlarm[] = [];
  for (const row of (data || []) as { owner_upn: string; value: string }[]) {
    const map = parse(row.value);
    for (const [id, list] of Object.entries(map)) {
      for (const a of list || []) {
        const t = new Date(a.at).getTime();
        if (!a.sent && Number.isFinite(t) && t <= limit) {
          out.push({ upn: String(row.owner_upn).toLowerCase(), taskId: Number(id), at: a.at });
        }
      }
    }
  }
  return out;
}

/** บันทึกว่ารอบนี้ส่งแล้ว — ทีละรอบ ไม่ใช่ทีละงาน */
export async function markSent(upn: string, taskId: number, at: string): Promise<void> {
  const map = await loadAlarms(upn);
  const list = map[String(taskId)];
  if (!list) return;
  for (const a of list) if (a.at === at) a.sent = true;
  await save(upn, map);
}

/**
 * ทิ้งรอบเตือนของงานที่ปิดไปแล้ว
 *
 * ไม่มีตัวนี้ ปิดงานแล้วยังโดนเตือนตามเวลาที่ตั้งไว้ ซึ่งน่ารำคาญกว่าไม่เตือนเลย
 * เรียกจาก cron รอบเดียวกับที่ส่ง จึงไม่ต้องไปแก้ทุกที่ที่ปิดงานได้
 */
export async function dropClosed(upn: string): Promise<number> {
  const map = await loadAlarms(upn);
  const ids = Object.keys(map);
  if (!ids.length) return 0;
  const tasks = await listTasks(upn);
  const open = new Set(
    tasks.filter((t) => t.status === "pending" || t.status === "overdue").map((t) => String(t.id))
  );
  let dropped = 0;
  for (const id of ids) {
    if (!open.has(id)) {
      delete map[id];
      dropped += 1;
    }
  }
  if (dropped) await save(upn, map);
  return dropped;
}
