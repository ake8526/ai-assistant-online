/**
 * ซิงค์งานเข้า Microsoft To Do — เปิดรายคน (ตอนนี้ทดลองกับบัญชีเดียวก่อน)
 *
 * To Do ไม่มีสิทธิ์แบบ app-only มีแต่ delegated แปลว่าเขียนได้เฉพาะ To Do ของ
 * เจ้าตัวที่กดอนุญาตเองและเราถือ refresh token ไว้ — เขียนเข้าลิสต์ของคนอื่น
 * ไม่ได้เลยแม้เขาจะยินดี (ต่างจากปฏิทินที่มีการแชร์)
 *
 * งานลงในลิสต์ชื่อ "KTIS X" แยกจากลิสต์ส่วนตัวของเขาโดยตั้งใจ — วันไหนซิงค์
 * เพี้ยนใส่งานซ้ำ ก็ลบทั้งลิสต์จบในทีเดียว ไม่ต้องมาคัดออกจากงานส่วนตัว
 *
 * เก็บ mapping (งานของเรา → id ใน To Do) ไว้ใน settings ไม่ได้เพิ่มคอลัมน์ใน
 * ตาราง tasks เพราะ migration บน Supabase ยังค้างอยู่หลายตัว
 */

import { graphGet, graphSend } from "@/lib/graph";
import { withDelegatedGraph, hasTasksConsent } from "@/lib/msGraphOAuth";
import {
  addTask,
  deleteTasks,
  getSetting,
  listTasks,
  setSetting,
  updateTaskStatus,
  type Task,
} from "@/lib/store";
import { admin } from "@/lib/supabaseServer";

/**
 * เรียก Graph ในนามเจ้าตัวเท่านั้น
 *
 * withDelegatedGraph จะตกไปเรียกแบบ app-only เองถ้าไม่มี token ของผู้ใช้ ซึ่งกับ
 * /me/todo จะพังด้วย error ที่อ่านไม่รู้เรื่อง — ดักตรงนี้แล้วบอกสาเหตุจริงดีกว่า
 */
async function asUser<T>(upn: string, fn: () => Promise<T>): Promise<T> {
  const { result, asUser: ok } = await withDelegatedGraph(upn, fn);
  if (!ok) throw new Error("ไม่มีสิทธิ์ของผู้ใช้ที่เก็บไว้ — To Do เรียกแบบ app-only ไม่ได้");
  return result;
}

const LIST_NAME = "KTIS X";
const K_ON = "todo_sync";
const K_LIST = "todo_list_id";
const K_MAP = "todo_map";
const K_LAST = "todo_last_sync";
const K_SEEN = "todo_seen";
/* เว้นช่วงต่อคน กันยิง Graph ซ้ำถี่เกินจำเป็น (สั่งเองด้วย «ซิงค์ todo» ไม่ติดเพดานนี้)
   
   เคยตั้งไว้ 3 นาที รวมกับเพดาน 8 คนต่อรอบแล้วงานที่พิมพ์ใน To Do ใช้เวลาเกือบ
   5 นาทีกว่าจะโผล่ในไลน์ ซึ่งช้าจนรู้สึกว่าไม่ทำงาน ตอนนี้อ่านทั้งลิสต์ครั้งเดียว
   ต่อคน (2 คำขอ) การไล่ทุกนาทีจึงไม่หนักอะไร */
const SWEEP_EVERY_MS = 60_000;
/** ซิงค์ได้กี่คนต่อรอบ — กันไม่ให้ cron ตัวเตือนงานหมดเวลาเพราะ To Do */
const MAX_PER_SWEEP = 12;

/**
 * งานที่ถือว่าจบแล้วจริง — มีแค่สองสถานะนี้
 *
 * ของเดิมเขียน `t.status !== "pending"` ซึ่งนับ "overdue" เป็นจบด้วย
 * lib/followup.ts เปลี่ยนงานเลยกำหนดเป็น overdue เอง ผลคือการ์ด «test» ของ
 * ผู้ใช้ถูกติ๊กว่าเสร็จใน To Do ทั้งที่ยังไม่ได้ทำ — งานเกินกำหนดคืองานที่ยัง
 * ค้างอยู่ ไม่ใช่งานที่ปิดแล้ว
 */
const CLOSED = new Set(["done", "cancelled"]);
/** งานที่ปิดแล้วไม่ต้องจำ mapping ไว้ตลอด — เก็บพอให้ปิดฝั่ง To Do ได้ */
const MAP_MAX = 300;

export type TodoSyncResult = {
  ok: boolean;
  reason?: string;
  created: number;
  completedInTodo: number;
  closedFromTodo: number;
  /** การ์ดที่ผู้ใช้พิมพ์เองในลิสต์ KTIS X แล้วดึงเข้ามาเป็นงานฝั่งนี้ */
  importedFromTodo: number;
  listId?: string;
};

/* ── สวิตช์รายคน ─────────────────────────────────────────────────────── */

export async function todoSyncOn(upn: string): Promise<boolean> {
  return (await getSetting(upn, K_ON)) === "on";
}

export async function setTodoSyncOn(upn: string, on: boolean): Promise<void> {
  await setSetting(upn, K_ON, on ? "on" : "");
}

/* ── การ์ดที่เคยดึงเข้ามาแล้ว ─────────────────────────────────────────── */

/**
 * จำ id การ์ดที่เคยดึงจาก To Do เข้ามาเป็นงาน — กันดึงซ้ำ
 *
 * mapping อย่างเดียวไม่พอ เพราะรอบไหนอ่านลิสต์ที่การ์ดอยู่ไม่เจอ (ผู้ใช้ย้าย
 * การ์ดไปลิสต์ที่เราไม่ได้อ่าน) ระบบจะถือว่าการ์ดถูกลบแล้วลืม mapping ทิ้ง
 * พอการ์ดโผล่กลับมาก็ดึงเข้ามาเป็นงานใหม่อีกใบ — เกิดขึ้นจริงกับการ์ด «test»
 * ได้งานซ้ำสองใบ (#145 กับ #149)
 */
async function loadSeen(upn: string): Promise<Set<string>> {
  const raw = await getSetting(upn, K_SEEN);
  if (!raw) return new Set();
  try {
    const a = JSON.parse(raw) as string[];
    return new Set(Array.isArray(a) ? a : []);
  } catch {
    return new Set();
  }
}

async function saveSeen(upn: string, seen: Set<string>): Promise<void> {
  // ใหม่สุดอยู่ท้าย — ตัดหัวทิ้งเมื่อยาวเกิน
  await setSetting(upn, K_SEEN, JSON.stringify([...seen].slice(-MAP_MAX)));
}

/* ── mapping ─────────────────────────────────────────────────────────── */

type Map = Record<string, string>;

async function loadMap(upn: string): Promise<Map> {
  const raw = await getSetting(upn, K_MAP);
  if (!raw) return {};
  try {
    const m = JSON.parse(raw) as Map;
    return m && typeof m === "object" ? m : {};
  } catch {
    return {};
  }
}

async function saveMap(upn: string, m: Map): Promise<void> {
  const keys = Object.keys(m);
  const trimmed: Map = {};
  // เก็บ id ใหม่สุดไว้ก่อน (id ของเราเป็นเลขวิ่ง ยิ่งมากยิ่งใหม่)
  for (const k of keys.sort((a, b) => Number(b) - Number(a)).slice(0, MAP_MAX)) trimmed[k] = m[k];
  await setSetting(upn, K_MAP, JSON.stringify(trimmed));
}

/* ── ลิสต์ ───────────────────────────────────────────────────────────── */

type RemoteList = { id: string; displayName?: string; wellknownListName?: string };

/**
 * ลิสต์ที่เกี่ยวข้อง — อ่านทีเดียวได้ทั้งลิสต์ปลายทางและลิสต์ที่ดึงงานเข้ามา
 *
 * `KTIS X` คือลิสต์ที่เราเขียนงานลงไป (สร้างให้ถ้ายังไม่มี)
 *
 * `import` เพิ่มลิสต์เริ่มต้นของ To Do เข้ามาด้วย (`wellknownListName` =
 * defaultList ซึ่งในเครื่องภาษาอังกฤษชื่อ "Tasks") เพราะคนพิมพ์งานลงลิสต์นี้
 * เป็นปกติ — เจ้าตัวพิมพ์ «test» ลงลิสต์ Tasks แล้วไม่เห็นในไลน์ ก็เข้าใจว่าพัง
 * ลิสต์ที่ผู้ใช้ตั้งเองชื่ออื่น (ของใช้ในบ้าน รายการซื้อของ) ยังไม่ถูกอ่าน
 */
async function resolveLists(upn: string): Promise<{ target: string; sources: string[] }> {
  const lists = ((await asUser(upn, () =>
    graphGet("/me/todo/lists", { $top: "50" })
  )) as { value?: RemoteList[] }).value || [];

  const cached = await getSetting(upn, K_LIST);
  let target = lists.find((l) => l.id === cached)?.id || lists.find((l) => l.displayName === LIST_NAME)?.id;
  if (!target) {
    // ลิสต์ถูกลบทิ้งไปแล้ว — สร้างใหม่ ไม่ใช่พังทั้งการซิงค์
    target = (
      (await asUser(upn, () =>
        graphSend("/me/todo/lists", "POST", { displayName: LIST_NAME })
      )) as { id: string }
    ).id;
  }
  if (target !== cached) await setSetting(upn, K_LIST, target);

  const sources = [target];
  const def = lists.find((l) => l.wellknownListName === "defaultList")?.id;
  if (def && def !== target) sources.push(def);
  return { target, sources };
}

/* ── แปลงงานของเรา → To Do ───────────────────────────────────────────── */

function bodyFor(t: Task): string {
  const lines: string[] = [];
  if (t.responsible) lines.push(`ผู้รับผิดชอบ: ${t.responsible}`);
  if (t.source && t.source !== "manual") lines.push(`จากประชุม: ${t.source}`);
  if (t.detail) lines.push("", t.detail);
  lines.push("", `อ้างอิงในผู้ช่วย KTIS X · งาน #${t.id}`);
  return lines.join("\n");
}

function payloadFor(t: Task) {
  const p: Record<string, unknown> = {
    title: t.title.slice(0, 255),
    body: { content: bodyFor(t), contentType: "text" },
  };
  if (t.due) {
    // To Do รับเวลาแบบระบุโซนเอง — ส่ง UTC ไปตรง ๆ แล้วให้แอปเขาแปลงให้ผู้ใช้
    const at = new Date(t.due).toISOString().replace("Z", "");
    p.dueDateTime = { dateTime: at, timeZone: "UTC" };
    /* ตั้งเตือนเฉพาะงานที่กำหนดส่งยังไม่ถึง — งานเก่าที่เลยกำหนดไปแล้วถ้าตั้ง
       เตือนย้อนหลัง To Do จะเด้งขึ้นมาทันทีพร้อมกันทั้งกอง วันแรกที่เปิดใช้ให้
       ทั้งบริษัทคือวันที่งานค้างเก่าทั้งหมดไหลเข้าไปพร้อมกัน */
    if (new Date(t.due).getTime() > Date.now()) {
      p.reminderDateTime = { dateTime: at, timeZone: "UTC" };
      p.isReminderOn = true;
    }
  }
  return p;
}

type RemoteTask = {
  id?: string;
  title?: string;
  status?: string;
  body?: { content?: string };
  dueDateTime?: { dateTime?: string; timeZone?: string };
  reminderDateTime?: { dateTime?: string; timeZone?: string };
};

/**
 * To Do ส่งเวลามาแบบไม่มี Z ต่อท้าย พร้อมชื่อโซนแยก — ปั้นกลับเป็น ISO
 *
 * ที่เห็นจริงคือ timeZone = "UTC" (การ์ด «test» ที่ผู้ใช้พิมพ์เอง 1 ก.ย. 2026)
 * ถ้าเจอชื่อโซนอื่นถือเป็นเวลาไทย ไม่ใช่ UTC — ผู้ใช้ทั้งองค์กรอยู่ไทย เดาผิด
 * ทางนี้คลาดไป 7 ชม.ในทิศที่ยังอ่านรู้เรื่อง ดีกว่าโยนกำหนดส่งทิ้งไปเลย
 */
function toIso(dt?: { dateTime?: string; timeZone?: string }): string | null {
  const raw = dt?.dateTime;
  if (!raw) return null;
  const zone = String(dt?.timeZone || "UTC").trim();
  const utc = /^(utc|gmt|etc\/gmt|utc\+00:00)$/i.test(zone);
  const iso = /[Zz]|[+-]\d{2}:\d{2}$/.test(raw) ? raw : `${raw}${utc ? "Z" : "+07:00"}`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * "เมื่อไหร่" ของการ์ดที่ผู้ใช้พิมพ์เอง — เอาเวลาเตือนก่อนกำหนดส่ง
 *
 * ใน To Do การตั้ง "Today" เก็บเป็นเที่ยงคืน ส่วนเวลาที่ผู้ใช้ตั้งจริงอยู่ในช่อง
 * เตือน (Remind me at 11:55) คนละช่องกัน ถ้าอ่านแต่กำหนดส่งจะได้เที่ยงคืน
 * แล้วไลน์แสดงเป็น 06:00 ตามกติกาของงานที่ไม่ระบุเวลา — ผู้ใช้เห็นสองที่ไม่ตรงกัน
 * ทั้งที่ระบบไม่ได้อ่านผิด แค่หยิบผิดช่อง
 */
function remoteDue(card: RemoteTask): string | null {
  return toIso(card.reminderDateTime) || toIso(card.dueDateTime);
}

/* ── ตัวซิงค์ ────────────────────────────────────────────────────────── */

/**
 * เดินทั้งสองทาง:
 *  - งานที่ยังค้างและยังไม่เคยส่ง → สร้างใน To Do
 *  - งานที่เราปิดแล้ว → ปิดใน To Do ตาม
 *  - งานที่เจ้าตัวไปติ๊กเสร็จใน To Do → ปิดในระบบเรา (ไม่งั้นตัวเตือนจะตามงาน
 *    ที่ทำเสร็จไปแล้ว ซึ่งน่ารำคาญกว่าไม่เตือนเลย)
 */
export async function syncTodoForUser(upn: string): Promise<TodoSyncResult> {
  const out: TodoSyncResult = {
    ok: false,
    created: 0,
    completedInTodo: 0,
    closedFromTodo: 0,
    importedFromTodo: 0,
  };
  if (!(await todoSyncOn(upn))) return { ...out, reason: "ยังไม่ได้เปิดซิงค์ To Do สำหรับบัญชีนี้" };
  if (!(await hasTasksConsent(upn))) {
    return { ...out, reason: "ยังไม่ได้อนุญาตสิทธิ์ Microsoft To Do — กดอนุญาตใหม่ที่หน้าตั้งค่า" };
  }

  const { target: listId, sources } = await resolveLists(upn);
  out.listId = listId;
  const map = await loadMap(upn);
  const tasks = await listTasks(upn);

  /* อ่านการ์ดของทุกลิสต์ที่เกี่ยวข้องทีเดียวแล้วทำ index ไว้
     
     ของเดิมยิง GET แยกทีละงานเพื่อดูสถานะ — cron รอบละนาที คนเดียวก็เกิน
     4,000 คำขอต่อวันแล้ว และโตตามจำนวนงานคูณจำนวนคน ลิสต์พวกนี้ขนาดคุมได้
     อ่านหน้าเดียว 200 การ์ดพอ (mapping เก็บไว้ 300)
     
     เก็บ id ลิสต์ไว้กับการ์ดด้วย เพราะการ์ดที่ดึงมาจากลิสต์เริ่มต้นยังอยู่ที่เดิม
     เวลาไปติ๊กปิดต้องยิงเข้าลิสต์นั้น ไม่ใช่ลิสต์ KTIS X */
  const byId = new Map<string, { card: RemoteTask; listId: string }>();
  const cards: { card: RemoteTask; listId: string }[] = [];
  let remoteOk = true;
  for (const src of sources) {
    try {
      const page = (await asUser(upn, () =>
        graphGet(`/me/todo/lists/${src}/tasks`, { $top: "200" })
      )) as { value?: RemoteTask[] };
      for (const card of page.value || []) {
        if (!card?.id) continue;
        cards.push({ card, listId: src });
        byId.set(card.id, { card, listId: src });
      }
    } catch (e) {
      remoteOk = false;
      out.reason = `อ่านลิสต์ To Do ไม่สำเร็จ: ${String(e).slice(0, 120)}`;
    }
  }

  for (const t of tasks) {
    const key = String(t.id);
    const todoId = map[key];
    const closedHere = CLOSED.has(t.status);

    if (!todoId) {
      // ปิดแล้วและไม่เคยส่งไป ก็ไม่ต้องไปสร้างของที่ทำเสร็จแล้วให้เกะกะ
      if (closedHere) continue;
      const made = (await asUser(upn, () =>
        graphSend(`/me/todo/lists/${listId}/tasks`, "POST", payloadFor(t))
      )) as { id?: string };
      if (made?.id) {
        map[key] = made.id;
        byId.set(made.id, { card: { id: made.id, title: t.title, status: "notStarted" }, listId });
        out.created += 1;
      }
      continue;
    }

    const hit = byId.get(todoId);
    if (!hit) {
      /* ไม่อยู่ในลิสต์ไหนแล้ว — ถูกลบใน To Do ก็ลืม mapping ทิ้ง รอบหน้าสร้างใหม่
         ถ้างานยังค้าง แต่ตอนอ่านลิสต์ไม่สำเร็จห้ามลืม ไม่งั้นจะสร้างซ้ำทั้งลิสต์ */
      if (remoteOk) delete map[key];
      continue;
    }

    const doneThere = hit.card.status === "completed";
    if (closedHere && !doneThere) {
      await asUser(upn, () =>
        graphSend(`/me/todo/lists/${hit.listId}/tasks/${todoId}`, "PATCH", { status: "completed" })
      );
      out.completedInTodo += 1;
    } else if (!closedHere && doneThere) {
      await updateTaskStatus(t.id, "done");
      out.closedFromTodo += 1;
    }
  }

  /* ทางกลับ: การ์ดที่เจ้าตัวพิมพ์เองใน To Do — ดึงเข้ามาเป็นงานฝั่งนี้ */
  const known = new Set(Object.values(map));
  const seen = await loadSeen(upn);
  let seenChanged = false;
  for (const { card } of cards) {
    if (!card.id || known.has(card.id) || seen.has(card.id)) continue;
    // ปิดไปแล้วไม่ต้องเอาเข้ามาให้เป็นงานค้างใหม่
    if (card.status === "completed") continue;
    const title = String(card.title || "").trim();
    if (!title) continue;
    const id = await addTask({
      owner_upn: upn,
      title: title.slice(0, 300),
      detail: String(card.body?.content || "").trim().slice(0, 2000),
      due: remoteDue(card),
      source: "todo",
    });
    if (id) {
      map[String(id)] = card.id;
      known.add(card.id);
      seen.add(card.id);
      seenChanged = true;
      out.importedFromTodo += 1;
    }
  }
  if (seenChanged) await saveSeen(upn, seen);

  await saveMap(upn, map);
  out.ok = true;
  return out;
}

/* ── รอบอัตโนมัติ ─────────────────────────────────────────────── */

/**
 * ซิงค์ให้ทุกคนที่เปิดสวิตช์ไว้ ─ เกาะไปกับ cron ตัวเตือนงาน
 *
 * ไม่มีตัวนี้ To Do จะอัปเดตแค่ตอนผู้ใช้พิมพ์ «ซิงค์ todo» เอง ซึ่งไม่ตรงกับที่
 * หน้าผลลัพธ์บอกไว้ว่า "งานใหม่จะเข้า To Do ให้เองอัตโนมัติ"
 *
 * คนหนึ่งพังไม่ลากคนอื่นล้ม ─ token หมดอายุหรือถอนสิทธิ์เป็นเรื่องรายคน
 */
export async function syncTodoForAll(): Promise<{
  users: number;
  /** ข้ามเพราะเพิ่งซิงค์ไปไม่ถึง SWEEP_EVERY_MS */
  skipped: number;
  /** ถึงคิวแล้วแต่เกินโควตาต่อรอบ — รอบถัดไปได้คิวก่อน */
  queued: number;
  created: number;
  completedInTodo: number;
  closedFromTodo: number;
  importedFromTodo: number;
  failed: { upn: string; error: string }[];
}> {
  const out = {
    users: 0,
    skipped: 0,
    queued: 0,
    created: 0,
    completedInTodo: 0,
    closedFromTodo: 0,
    importedFromTodo: 0,
    failed: [] as { upn: string; error: string }[],
  };

  const { data } = await admin.from("settings").select("owner_upn").eq("key", K_ON).eq("value", "on");
  const upns = ((data || []) as { owner_upn: string }[])
    .map((r) => String(r.owner_upn || "").toLowerCase())
    .filter(Boolean);
  if (!upns.length) return out;

  /* อ่านเวลาซิงค์ล่าสุดของทุกคนทีเดียว ไม่ต้องยิงทีละคน */
  const { data: lastRows } = await admin
    .from("settings")
    .select("owner_upn,value")
    .eq("key", K_LAST)
    .in("owner_upn", upns);
  const lastOf = new Map(
    ((lastRows || []) as { owner_upn: string; value: string }[]).map((r) => [
      String(r.owner_upn).toLowerCase(),
      Number(r.value) || 0,
    ])
  );

  const now = Date.now();
  const due = upns.filter((u) => now - (lastOf.get(u) || 0) >= SWEEP_EVERY_MS);
  out.skipped = upns.length - due.length;

  /* คนที่รอนานสุดได้คิวก่อน แล้วตัดที่ MAX_PER_SWEEP
     
     route นี้มี maxDuration 60 วินาที และเป็น cron ตัวเตือนงานที่ต้องตรงเวลา
     ปล่อยให้ To Do ของคนที่ 30 ลากจนหมดเวลา = การเตือนงานทั้งระบบพังตาม
     ตัดจำนวนต่อรอบไว้ คนที่เหลือได้คิวในนาทีถัดไปเอง */
  due.sort((x, y) => (lastOf.get(x) || 0) - (lastOf.get(y) || 0));
  const batch = due.slice(0, MAX_PER_SWEEP);
  out.queued = due.length - batch.length;

  const deadline = now + 35_000;
  for (const upn of batch) {
    if (Date.now() > deadline) {
      out.queued += 1;
      continue;
    }
    out.users += 1;
    try {
      const r = await syncTodoForUser(upn);
      if (!r.ok) {
        out.failed.push({ upn, error: r.reason || "ไม่ทราบสาเหตุ" });
        continue;
      }
      await setSetting(upn, K_LAST, String(Date.now()));
      out.created += r.created;
      out.completedInTodo += r.completedInTodo;
      out.closedFromTodo += r.closedFromTodo;
      out.importedFromTodo += r.importedFromTodo;
    } catch (e) {
      out.failed.push({ upn, error: String(e).slice(0, 160) });
    }
  }
  return out;
}

/* ── ลบงานทิ้ง ───────────────────────────────────────────── */

/**
 * ลบงานทั้งสองฝั่ง — ในระบบและการ์ดใน To Do ของเจ้าตัว
 *
 * ลบแค่ฝั่งเราไม่พอ การ์ดจะค้างอยู่ในแอปของเขาโดยไม่มีอะไรมาปิดให้อีกเลย
 * (ตัวซิงค์เดินจากงานฝั่งเราไปหาการ์ด ไม่มีงานก็ไม่มีใครไปแตะการ์ดนั้น)
 *
 * ลบการ์ดก่อนแล้วค่อยลบงาน — ถ้าสลับกันแล้วการลบการ์ดพัง จะเหลือการ์ดกำพร้า
 * ที่ไม่มีทางตามเก็บได้ เพราะ mapping หายไปพร้อมงาน
 */
export async function deleteTasksEverywhere(
  upn: string,
  ids: number[]
): Promise<{ removed: number; cardsRemoved: number; cardsFailed: number }> {
  const out = { removed: 0, cardsRemoved: 0, cardsFailed: 0 };
  if (!ids.length) return out;

  const map = await loadMap(upn);
  const listId = await getSetting(upn, K_LIST);
  const mapped = ids.filter((i) => map[String(i)]);

  if (listId && mapped.length) {
    for (const id of mapped) {
      try {
        await asUser(upn, () =>
          graphSend(`/me/todo/lists/${listId}/tasks/${map[String(id)]}`, "DELETE")
        );
        out.cardsRemoved += 1;
      } catch {
        // การ์ดถูกลบไปแล้วหรือเรียกไม่ผ่าน — ไม่ใช่เหตุให้ไม่ลบงานฝั่งเรา
        out.cardsFailed += 1;
      }
      delete map[String(id)];
    }
    await saveMap(upn, map);
  }

  out.removed = await deleteTasks(upn, ids);
  return out;
}
