/**
 * ระงับการใช้งานรายคน แยกตามช่องทาง
 *
 * ก่อนหน้านี้ไม่มีทางปิดการใช้งานของใครเลยนอกจากไปลบแถวใน Supabase ด้วยมือ
 * ซึ่งไม่เหลือร่องรอยว่าใครสั่งและเมื่อไร และคนที่ถูกลบ line_links ก็จะเจอการ์ด
 * "ผูกบัญชี" แล้วผูกกลับมาเองได้ทันที — การระงับต้องเป็นสถานะที่ตั้งใจ ไม่ใช่
 * ผลข้างเคียงของการลบข้อมูล
 *
 * เก็บเป็นแถวเดียวใน settings (_ops/blocked) จึงไม่ต้องรอ migration
 *
 * ด่านบังคับอยู่สองที่เท่านั้น: requireUser (ทุก API ของเว็บและแอปผ่านตัวนี้)
 * และต้นทางของ webhook ไลน์ — ไม่ต้องไปแก้ทุก route
 */

import { getSetting, setSetting } from "@/lib/store";
import { isRootAdmin } from "@/lib/roles";

const OWNER = "_ops";
const KEY = "blocked";

export type Channel = "line" | "web";
export type BlockEntry = { line?: boolean; web?: boolean; at?: string; by?: string; note?: string };
export type BlockMap = Record<string, BlockEntry>;

const norm = (upn: string) => (upn || "").trim().toLowerCase();

/* requireUser ถูกเรียกทุกคำขอ อ่าน settings ใหม่ทุกครั้งคือเพิ่มเวลาให้ทุกหน้า
   จำไว้สั้น ๆ พอ: ระงับแล้วมีผลช้าสุด 20 วินาที ซึ่งรับได้ */
let cache: { at: number; map: BlockMap } | null = null;
const TTL_MS = 20_000;

export async function loadBlocked(fresh = false): Promise<BlockMap> {
  if (!fresh && cache && Date.now() - cache.at < TTL_MS) return cache.map;
  const raw = await getSetting(OWNER, KEY);
  let map: BlockMap = {};
  try {
    const parsed = raw ? (JSON.parse(raw) as BlockMap) : {};
    if (parsed && typeof parsed === "object") map = parsed;
  } catch {
    map = {};
  }
  cache = { at: Date.now(), map };
  return map;
}

export async function isBlocked(upn: string, channel: Channel): Promise<boolean> {
  const u = norm(upn);
  if (!u || isRootAdmin(u)) return false;
  const e = (await loadBlocked())[u];
  return !!e?.[channel];
}

/**
 * เปิด/ปิดการระงับ
 *
 * บัญชีเจ้าของระบบระงับไม่ได้ — ตั้งใจให้ล็อกตัวเองออกจากหน้าจัดการไม่ได้
 * เพราะถ้าล็อกได้ก็ไม่มีใครปลดคืนได้อีก
 */
export async function setBlocked(
  upn: string,
  channel: Channel,
  on: boolean,
  by: string
): Promise<{ ok: boolean; reason?: string; entry: BlockEntry }> {
  const u = norm(upn);
  if (!u) return { ok: false, reason: "ไม่มี upn", entry: {} };
  if (isRootAdmin(u) && on) {
    return { ok: false, reason: "บัญชีผู้ดูแลระบบหลักระงับไม่ได้", entry: {} };
  }
  const map = await loadBlocked(true);
  const e: BlockEntry = { ...(map[u] || {}) };
  e[channel] = on || undefined;
  e.at = new Date().toISOString();
  e.by = norm(by);
  if (!e.line && !e.web) delete map[u];
  else map[u] = e;
  await setSetting(OWNER, KEY, JSON.stringify(map));
  cache = { at: Date.now(), map };
  return { ok: true, entry: e };
}

export function blockedMessage(channel: Channel): string {
  return channel === "line"
    ? "บัญชีนี้ถูกระงับการใช้งานผู้ช่วยทางไลน์ครับ — ติดต่อทีม IT ของ KTIS Group หากต้องการใช้งานต่อ"
    : "บัญชีนี้ถูกระงับการใช้งาน — ติดต่อทีม IT ของ KTIS Group";
}
