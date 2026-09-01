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
import { addTask, getSetting, listTasks, setSetting, updateTaskStatus, type Task } from "@/lib/store";
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
/* cron ตัวเตือนงานเดินทุกนาที แต่ To Do ไม่ต้องละเอียดขนาดนั้น — เว้นช่วงไว้
   ไม่ให้ยิง Graph ฟรี ๆ ทุกนาทีต่อคน (สั่งเองด้วย «ซิงค์ todo» ไม่ติดเพดานนี้) */
const SWEEP_EVERY_MS = 3 * 60_000;
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

/** หา (หรือสร้าง) ลิสต์ "KTIS X" แล้วจำ id ไว้ ไม่ต้องถามใหม่ทุกครั้ง */
async function ensureList(upn: string): Promise<string> {
  const cached = await getSetting(upn, K_LIST);
  if (cached) {
    try {
      await asUser(upn, () => graphGet(`/me/todo/lists/${cached}`));
      return cached;
    } catch {
      // ลิสต์ถูกลบทิ้งไปแล้ว — สร้างใหม่ ไม่ใช่พังทั้งการซิงค์
    }
  }
  const lists = (await asUser(upn, () =>
    graphGet("/me/todo/lists", { $top: "50" })
  )) as { value?: { id: string; displayName: string }[] };
  const found = (lists.value || []).find((l) => l.displayName === LIST_NAME);
  const id =
    found?.id ||
    (
      (await asUser(upn, () =>
        graphSend("/me/todo/lists", "POST", { displayName: LIST_NAME })
      )) as { id: string }
    ).id;
  await setSetting(upn, K_LIST, id);
  return id;
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
    p.dueDateTime = { dateTime: new Date(t.due).toISOString().replace("Z", ""), timeZone: "UTC" };
    p.reminderDateTime = { dateTime: new Date(t.due).toISOString().replace("Z", ""), timeZone: "UTC" };
    p.isReminderOn = true;
  }
  return p;
}

type RemoteTask = {
  id?: string;
  title?: string;
  status?: string;
  body?: { content?: string };
  dueDateTime?: { dateTime?: string; timeZone?: string };
};

/** To Do ส่งเวลามาแบบไม่มี Z ต่อท้าย พร้อมชื่อโซนแยก ─ ปั้นกลับเป็น ISO */
function remoteDue(card: RemoteTask): string | null {
  const raw = card.dueDateTime?.dateTime;
  if (!raw) return null;
  const iso = /[Zz]|[+-]\d{2}:\d{2}$/.test(raw) ? raw : `${raw}Z`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
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

  const listId = await ensureList(upn);
  out.listId = listId;
  const map = await loadMap(upn);
  const tasks = await listTasks(upn);

  /* อ่านการ์ดทั้งลิสต์ทีเดียวแล้วทำ index ไว้
     
     ของเดิมยิง GET แยกทีละงานเพื่อดูสถานะ — cron รอบละนาที คนเดียวก็เกิน
     4,000 คำขอต่อวันแล้ว และโตตามจำนวนงานคูณจำนวนคน ลิสต์นี้เป็นลิสต์ที่ระบบ
     สร้างเอง ขนาดจึงคุมได้ อ่านหน้าเดียว 200 การ์ดพอ (mapping เก็บไว้ 300) */
  let cards: RemoteTask[] = [];
  let remoteOk = true;
  try {
    const page = (await asUser(upn, () =>
      graphGet(`/me/todo/lists/${listId}/tasks`, { $top: "200" })
    )) as { value?: RemoteTask[] };
    cards = page.value || [];
  } catch (e) {
    remoteOk = false;
    out.reason = `อ่านลิสต์ To Do ไม่สำเร็จ: ${String(e).slice(0, 120)}`;
  }
  const byId = new Map(cards.filter((c) => c.id).map((c) => [c.id!, c]));

  for (const t of tasks) {
    const key = String(t.id);
    const todoId = map[key];
    const closedHere = t.status !== "pending";

    if (!todoId) {
      // ปิดแล้วและไม่เคยส่งไป ก็ไม่ต้องไปสร้างของที่ทำเสร็จแล้วให้เกะกะ
      if (closedHere) continue;
      const made = (await asUser(upn, () =>
        graphSend(`/me/todo/lists/${listId}/tasks`, "POST", payloadFor(t))
      )) as { id?: string };
      if (made?.id) {
        map[key] = made.id;
        byId.set(made.id, { id: made.id, title: t.title, status: "notStarted" });
        out.created += 1;
      }
      continue;
    }

    const card = byId.get(todoId);
    if (!card) {
      /* ไม่อยู่ในลิสต์แล้ว — ถูกลบใน To Do ก็ลืม mapping ทิ้ง รอบหน้าสร้างใหม่
         ถ้างานยังค้าง แต่ตอนอ่านลิสต์ไม่สำเร็จห้ามลืม ไม่งั้นจะสร้างซ้ำทั้งลิสต์ */
      if (remoteOk) delete map[key];
      continue;
    }

    const doneThere = card.status === "completed";
    if (closedHere && !doneThere) {
      await asUser(upn, () =>
        graphSend(`/me/todo/lists/${listId}/tasks/${todoId}`, "PATCH", { status: "completed" })
      );
      out.completedInTodo += 1;
    } else if (!closedHere && doneThere) {
      await updateTaskStatus(t.id, "done");
      out.closedFromTodo += 1;
    }
  }

  /* ทางกลับ: การ์ดที่เจ้าตัวพิมพ์เองในลิสต์ KTIS X — ดึงเข้ามาเป็นงานฝั่งนี้
     
     ดึงจากลิสต์ KTIS X ลิสต์เดียว ไม่ไล่ทุกลิสต์ในบัญชี — ลิสต์ Tasks กับ
     ลิสต์ส่วนตัวมีเรื่องบ้าน เรื่องซื้อของ ที่ไม่ควรโผล่มาในไลน์ที่ทำงาน
     ลิสต์นี้เป็นลิสต์ที่ระบบสร้างเอง ใครพิมพ์ลงในนี้ถือว่าตั้งใจให้ผู้ช่วยเห็น */
  const known = new Set(Object.values(map));
  for (const card of cards) {
    if (!card?.id || known.has(card.id)) continue;
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
      out.importedFromTodo += 1;
    }
  }

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
  created: number;
  completedInTodo: number;
  closedFromTodo: number;
  importedFromTodo: number;
  failed: { upn: string; error: string }[];
}> {
  const out = {
    users: 0,
    skipped: 0,
    created: 0,
    completedInTodo: 0,
    closedFromTodo: 0,
    importedFromTodo: 0,
    failed: [] as { upn: string; error: string }[],
  };
  const { data } = await admin
    .from("settings")
    .select("owner_upn")
    .eq("key", K_ON)
    .eq("value", "on");
  for (const row of (data || []) as { owner_upn: string }[]) {
    const upn = String(row.owner_upn || "").toLowerCase();
    if (!upn) continue;
    const last = Number(await getSetting(upn, K_LAST)) || 0;
    if (Date.now() - last < SWEEP_EVERY_MS) {
      out.skipped += 1;
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
