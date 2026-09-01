/**
 * กล่องแจ้งเตือนในแอป — ทุกอย่างที่ผู้ช่วยส่งออกไป เก็บไว้ให้ย้อนอ่านได้
 *
 * เดิมการแจ้งเตือนทั้งหมดไปทาง LINE ทางเดียว ใครไม่ได้เชื่อม LINE หรือโควตา
 * push เดือนนั้นหมด ก็ไม่เคยรู้เลยว่ามีอะไรส่งมา และต่อให้ได้รับก็ไล่หาย้อนหลัง
 * ในแชทไม่ไหว กล่องนี้เก็บสำเนาไว้ทุกฉบับ อ่านย้อนหลังได้ในแอป
 *
 * เก็บใน settings (คีย์ "inbox") เป็น JSON ก้อนเดียวต่อคน — ตารางนี้มีอยู่แล้ว
 * และผ่าน service key เท่านั้น จึงไม่ต้องรอ migration ที่ค้างอยู่บน Supabase
 * แลกกับข้อจำกัดว่าเขียนพร้อมกันหลายทางจะทับกันได้ ตัวส่งทั้งหมดวิ่งจาก cron
 * ทีละคนอยู่แล้ว จึงยอมรับได้ และเก็บแค่ล่าสุด 60 ฉบับ / 30 วัน
 */

import { getSetting, setSetting } from "@/lib/store";

export type NoticeKind = "brief" | "news" | "task" | "meeting" | "system";

export type Notice = {
  id: string;
  kind: NoticeKind;
  title: string;
  body: string;
  /** เวลาที่เกิดเรื่อง (epoch ms) */
  at: number;
  /** เวลาที่กดอ่าน — ไม่มีคือยังไม่อ่าน */
  read?: number;
};

const KEY = "inbox";
const MAX = 60;
const DAYS = 30;

function parse(raw: string | null): Notice[] {
  if (!raw) return [];
  try {
    const rows = JSON.parse(raw) as Notice[];
    if (!Array.isArray(rows)) return [];
    const cutoff = Date.now() - DAYS * 24 * 60 * 60_000;
    return rows
      .filter((n) => n && typeof n.at === "number" && n.at >= cutoff && !!n.title)
      .sort((a, b) => b.at - a.at)
      .slice(0, MAX);
  } catch {
    return [];
  }
}

export async function listNotices(upn: string): Promise<Notice[]> {
  if (!upn) return [];
  return parse(await getSetting(upn, KEY));
}

export async function unreadCount(upn: string): Promise<number> {
  return (await listNotices(upn)).filter((n) => !n.read).length;
}

/**
 * เก็บแจ้งเตือนหนึ่งฉบับ — เรียกคู่กับตอนส่ง LINE เสมอ เพื่อให้กล่องในแอปกับ
 * สิ่งที่ผู้ใช้ได้รับจริงตรงกัน ส่ง LINE ไม่ผ่านก็ยังต้องเก็บ เพราะกล่องนี้คือ
 * ทางเดียวที่เขาจะได้เห็นข้อความนั้น
 */
export async function addNotice(
  upn: string,
  n: { kind: NoticeKind; title: string; body: string; at?: number }
): Promise<void> {
  if (!upn || !n?.title) return;
  const at = n.at ?? Date.now();
  const rows = await listNotices(upn);
  // กันซ้ำ: เรื่องเดียวกันหัวเดียวกันภายใน 10 นาที ถือว่าเป็นฉบับเดิมที่ยิงซ้ำ
  const dup = rows.find(
    (r) => r.kind === n.kind && r.title === n.title && Math.abs(r.at - at) < 10 * 60_000
  );
  if (dup) return;
  const id = `${at.toString(36)}${Math.floor(at % 1000).toString(36)}`;
  const next = [{ id, kind: n.kind, title: n.title, body: n.body || "", at }, ...rows].slice(0, MAX);
  await setSetting(upn, KEY, JSON.stringify(next));
}

/** กดอ่านแล้ว — "all" คืออ่านทั้งกล่อง */
export async function markRead(upn: string, id: string): Promise<Notice[]> {
  const rows = await listNotices(upn);
  const now = Date.now();
  const next = rows.map((n) => (id === "all" || n.id === id ? { ...n, read: n.read ?? now } : n));
  await setSetting(upn, KEY, JSON.stringify(next));
  return next;
}
