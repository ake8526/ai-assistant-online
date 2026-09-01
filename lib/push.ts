/**
 * แจ้งเตือนขึ้นเครื่อง แม้ปิดแอปอยู่ — Firebase Cloud Messaging (HTTP v1)
 *
 * เดิมแจ้งเตือนทุกอย่างไปทาง LINE ทางเดียว ปิดแอปแล้วไม่มีอะไรเด้ง และ push
 * ของ LINE มีโควตาเดือนละ 300 ครั้งซึ่งเคยหมดกลางเดือนมาแล้ว ทางนี้ยิงตรงเข้า
 * เครื่องผ่าน FCM ไม่มีโควตาแบบนั้น และทำงานตอนแอปปิดสนิท
 *
 * ต้องมี env ครบสามตัวถึงจะทำงาน (ไม่มีก็เงียบ ๆ ข้ามไป ไม่ทำให้ตัวส่งอื่นพัง):
 *   FCM_PROJECT_ID     — ktis-x-assistant
 *   FCM_CLIENT_EMAIL   — จาก service account JSON (client_email)
 *   FCM_PRIVATE_KEY    — จาก service account JSON (private_key) ขึ้นบรรทัดใหม่เป็น \n ได้
 *
 * ฝั่งแอป Android ต้องส่ง token ของเครื่องเข้ามาที่ /api/push/register
 * (ดู docs/push-fcm.md ว่าเปลือกแอปต้องทำอะไรบ้าง)
 */

import { createSign } from "node:crypto";
import { getSetting, setSetting } from "@/lib/store";

const TOKENS_KEY = "push_tokens";
const MAX_TOKENS = 8;
/** โทเคนที่ไม่ถูกใช้เกินสองเดือน ถือว่าเครื่องนั้นเลิกใช้แล้ว */
const TOKEN_TTL_DAYS = 60;

type DeviceToken = { t: string; at: number; plat?: string };

/**
 * ทำคีย์ที่คนวางมาให้ node อ่านออก
 *
 * คีย์ใน service account JSON เป็น PEM ที่มีขึ้นบรรทัดจริง แต่เวลาคัดลอกจากไฟล์
 * ไปวางในช่อง env มันเพี้ยนได้หลายแบบ และทุกแบบให้ error เดียวกันคือ
 * "DECODER routines::unsupported" ซึ่งไม่บอกว่าเพี้ยนตรงไหน (เกิดขึ้นจริง)
 *  - ติดเครื่องหมายคำพูดหัวท้ายมาจาก JSON
 *  - เป็น \n ตัวอักษรสองตัว ไม่ใช่ขึ้นบรรทัดจริง
 *  - ขึ้นบรรทัดหายหมดกลายเป็นบรรทัดเดียว
 *  - มี \r ปนมาจาก Windows
 * ตัวนี้รับมาได้ทุกแบบ แล้วประกอบ PEM ใหม่ให้ถูกรูป
 */
function normalizeKey(raw: string): string {
  let k = (raw || "").trim();
  if (k.length > 1 && ((k.startsWith('"') && k.endsWith('"')) || (k.startsWith("'") && k.endsWith("'")))) {
    k = k.slice(1, -1);
  }
  k = k.replace(/\\r/g, "").replace(/\\n/g, "\n").replace(/\r/g, "").trim();
  const m = k.match(/-----BEGIN ([A-Z ]+)-----([\s\S]*?)-----END \1-----/);
  if (m) {
    const body = m[2].replace(/\s+/g, "");
    const lines = body.match(/.{1,64}/g) || [];
    k = `-----BEGIN ${m[1]}-----\n${lines.join("\n")}\n-----END ${m[1]}-----\n`;
  } else if (!k.endsWith("\n")) {
    k += "\n";
  }
  return k;
}

const unquote = (v: string) => (v || "").trim().replace(/^["']|["']$/g, "");

/**
 * ทางที่พลาดยากที่สุด: วางไฟล์ service account ทั้งไฟล์ลงตัวแปรเดียว
 *
 * แยกใส่สามตัวแปรแล้วพลาดกันบ่อย — คนละบรรทัดกัน คีย์ยาวจนล้นจอ และมีบรรทัด
 * "private_key_id" หน้าตาคล้าย "private_key" ให้หยิบผิดได้ง่าย (เกิดขึ้นจริง)
 * วางทั้งไฟล์แบบนี้ไม่ต้องเลือกอะไรเลย
 */
function fromJsonEnv() {
  const raw = (process.env.FCM_SERVICE_ACCOUNT || "").trim();
  if (!raw.startsWith("{")) return null;
  try {
    const j = JSON.parse(raw) as { project_id?: string; client_email?: string; private_key?: string };
    const projectId = unquote(j.project_id || "");
    const clientEmail = unquote(j.client_email || "");
    const privateKey = normalizeKey(j.private_key || "");
    if (!projectId || !clientEmail || !privateKey.includes("PRIVATE KEY")) return null;
    return { projectId, clientEmail, privateKey };
  } catch {
    return null;
  }
}

function creds() {
  const whole = fromJsonEnv();
  if (whole) return whole;
  const projectId = unquote(process.env.FCM_PROJECT_ID || "");
  const clientEmail = unquote(process.env.FCM_CLIENT_EMAIL || "");
  const privateKey = normalizeKey(process.env.FCM_PRIVATE_KEY || "");
  if (!projectId || !clientEmail || !privateKey.includes("PRIVATE KEY")) return null;
  return { projectId, clientEmail, privateKey };
}

/**
 * ตรวจว่าคีย์ใช้ได้จริงไหม — ขอ access token หนึ่งครั้งแล้วบอกว่าติดตรงไหน
 *
 * แยก "ยังไม่ได้ตั้งค่า" กับ "ตั้งแล้วแต่คีย์เพี้ยน" ให้ชัด เพราะสองอันนี้อาการ
 * หน้างานเหมือนกันเป๊ะ คือแจ้งเตือนไม่เด้งเฉย ๆ
 */
export async function pushSelfCheck(): Promise<{ ok: boolean; error?: string }> {
  if (!creds()) {
    return {
      ok: false,
      error:
        "ยังไม่ได้ตั้งค่า หรือคีย์ไม่ใช่ PEM — วางไฟล์ service account ทั้งไฟล์ลง FCM_SERVICE_ACCOUNT " +
        "ตัวเดียวจบ (หรือใส่ FCM_PROJECT_ID / FCM_CLIENT_EMAIL / FCM_PRIVATE_KEY ให้ครบ)",
    };
  }
  try {
    const t = await accessToken();
    return t
      ? { ok: true }
      : { ok: false, error: "ขอ access token จาก Google ไม่ผ่าน — ตรวจ FCM_CLIENT_EMAIL และคีย์" };
  } catch (e) {
    const msg = String((e as Error).message || e);
    if (/DECODER|unsupported|PEM|asn1/i.test(msg)) {
      return {
        ok: false,
        error: `FCM_PRIVATE_KEY อ่านไม่ออก — ต้องเป็นค่าใน "private_key" ทั้งก้อนรวมบรรทัด BEGIN/END (${msg.slice(0, 60)})`,
      };
    }
    return { ok: false, error: msg.slice(0, 160) };
  }
}

export function pushConfigured(): boolean {
  return !!creds();
}

/* ── โทเคนของเครื่อง ─────────────────────────────────────────────────── */

async function loadTokens(upn: string): Promise<DeviceToken[]> {
  const raw = await getSetting(upn, TOKENS_KEY);
  if (!raw) return [];
  try {
    const rows = JSON.parse(raw) as DeviceToken[];
    if (!Array.isArray(rows)) return [];
    const cutoff = Date.now() - TOKEN_TTL_DAYS * 24 * 60 * 60_000;
    return rows.filter((r) => r?.t && typeof r.at === "number" && r.at >= cutoff);
  } catch {
    return [];
  }
}

async function saveTokens(upn: string, rows: DeviceToken[]): Promise<void> {
  await setSetting(upn, TOKENS_KEY, JSON.stringify(rows.slice(0, MAX_TOKENS)));
}

/** เครื่องหนึ่งเครื่องรายงานตัวเข้ามา — เรียกซ้ำได้ ถือเป็นการต่ออายุ */
export async function registerDevice(upn: string, token: string, plat = "android"): Promise<void> {
  if (!upn || !token) return;
  const rows = await loadTokens(upn);
  const rest = rows.filter((r) => r.t !== token);
  await saveTokens(upn, [{ t: token, at: Date.now(), plat }, ...rest]);
}

export async function forgetDevice(upn: string, token: string): Promise<void> {
  if (!upn || !token) return;
  await saveTokens(
    upn,
    (await loadTokens(upn)).filter((r) => r.t !== token)
  );
}

export async function deviceCount(upn: string): Promise<number> {
  return (await loadTokens(upn)).length;
}

/* ── access token ของ Google ─────────────────────────────────────────── */

let cached: { token: string; exp: number } | null = null;

const b64url = (b: Buffer | string) =>
  Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function accessToken(): Promise<string | null> {
  const c = creds();
  if (!c) return null;
  // เผื่อเวลาหมดอายุไว้ 60 วิ กันกรณีขอมาแล้วใช้ไม่ทัน
  if (cached && cached.exp > Date.now() + 60_000) return cached.token;

  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(
    JSON.stringify({
      iss: c.clientEmail,
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    })
  );
  const sig = b64url(createSign("RSA-SHA256").update(`${header}.${claim}`).sign(c.privateKey));

  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${header}.${claim}.${sig}`,
    }),
  });
  if (!r.ok) return null;
  const j = (await r.json()) as { access_token?: string; expires_in?: number };
  if (!j.access_token) return null;
  cached = { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return cached.token;
}

/* ── ส่ง ──────────────────────────────────────────────────────────────── */

/**
 * ส่งแจ้งเตือนขึ้นเครื่องทุกเครื่องของผู้ใช้คนนี้ — คืนจำนวนเครื่องที่ส่งสำเร็จ
 *
 * โทเคนที่ FCM บอกว่าใช้ไม่ได้แล้ว (ถอนแอป/ล้างข้อมูล) ลบทิ้งทันที ไม่งั้น
 * ทุกรอบจะเสียเวลายิงใส่เครื่องที่ไม่มีอยู่จริง
 */
export async function sendPush(
  upn: string,
  msg: { title: string; body: string; tag?: string }
): Promise<number> {
  const c = creds();
  if (!c || !upn || !msg?.title) return 0;
  const rows = await loadTokens(upn);
  if (!rows.length) return 0;
  const token = await accessToken();
  if (!token) return 0;

  const url = `https://fcm.googleapis.com/v1/projects/${c.projectId}/messages:send`;
  const dead: string[] = [];
  let sent = 0;

  for (const row of rows) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          message: {
            token: row.t,
            notification: { title: msg.title, body: msg.body.slice(0, 900) },
            // แตะแล้วเปิดแอปที่กล่องแจ้งเตือน — เปลือกแอปอ่านค่านี้ไปเปิดหน้า
            data: { open: "inbox", tag: msg.tag || "" },
            android: {
              priority: "HIGH",
              notification: { channel_id: "ktisx", tag: msg.tag || undefined },
            },
          },
        }),
      });
      if (r.ok) {
        sent++;
        continue;
      }
      const text = await r.text();
      if (r.status === 404 || /UNREGISTERED|INVALID_ARGUMENT/i.test(text)) dead.push(row.t);
    } catch {
      /* เครื่องเดียวส่งไม่ได้ ไม่ควรทำให้เครื่องที่เหลือไม่ได้รับ */
    }
  }

  if (dead.length) await saveTokens(upn, rows.filter((r) => !dead.includes(r.t)));
  return sent;
}
