import { NextResponse } from "next/server";
import { guard } from "@/lib/guard";
import { admin, assertConfigured } from "@/lib/supabaseServer";
import { hasTasksConsent } from "@/lib/msGraphOAuth";
import { deleteTasksEverywhere, setTodoSyncOn, syncTodoForUser } from "@/lib/todoSync";

/**
 * ข้อมูลและปุ่มของหน้า /monitor/todo
 *
 * งานจะกองซ้ำเป็นสิบใบจากประชุมครั้งเดียวได้ (13 ส.ค. 2026: ประชุมเดียวแตกเป็น
 * 43 งานใน 8 รอบ) เวลาเกิดเรื่องแบบนั้นเดิมต้องมาไล่ลบให้ทีละคนจากหลังบ้าน
 * หน้านี้จึงจัดกลุ่มตาม "ประชุมไหน วันไหน ของใคร" ให้เห็นทั้งกองแล้วลบทีเดียว
 *
 * ลบทีละกลุ่มเท่านั้น ไม่มีปุ่มล้างทั้งตาราง — ของแบบนั้นพลาดแล้วไม่มีทางกลับ
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const TZ_MS = 7 * 3600_000;

/** วันแบบไทยของ timestamp ที่เก็บเป็น UTC */
function bkkDay(iso: string): string {
  return new Date(new Date(iso).getTime() + TZ_MS).toISOString().slice(0, 10);
}

type Row = {
  id: number;
  owner_upn: string;
  title: string;
  responsible: string | null;
  status: string;
  source: string | null;
  due: string | null;
  created_at: string;
};

export async function GET(req: Request) {
  const gate = await guard(req, "todo.manage");
  if (!gate.ok) return gate.response;
  try {
    assertConfigured();
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 503 });
  }

  const [{ data: tasks }, { data: settings }, { data: tokens }] = await Promise.all([
    admin
      .from("tasks")
      .select("id,owner_upn,title,responsible,status,source,due,created_at")
      .in("status", ["pending", "overdue"])
      .order("created_at", { ascending: false }),
    admin.from("settings").select("owner_upn,key,value").in("key", ["todo_sync", "todo_map", "todo_last_sync"]),
    admin.from("oauth_tokens").select("owner_upn,scope").eq("provider", "microsoft"),
  ]);

  const rows = (tasks || []) as Row[];
  const setOf = (upn: string, key: string) =>
    (settings || []).find((s) => s.owner_upn === upn && s.key === key)?.value || "";

  const people = new Set<string>();
  (tokens || []).forEach((t) => people.add(String(t.owner_upn).toLowerCase()));
  rows.forEach((r) => people.add(r.owner_upn.toLowerCase()));

  const users = [...people].sort().map((upn) => {
    let cards = 0;
    try {
      cards = Object.keys(JSON.parse(setOf(upn, "todo_map") || "{}")).length;
    } catch {
      cards = 0;
    }
    const scope = (tokens || []).find((t) => String(t.owner_upn).toLowerCase() === upn)?.scope || "";
    const last = Number(setOf(upn, "todo_last_sync")) || 0;
    return {
      upn,
      on: setOf(upn, "todo_sync") === "on",
      // scope ที่เก็บไว้พอสำหรับการ "แสดงผล" — การถาม Entra จริงทุกคนทุกครั้งที่
      // เปิดหน้าคือ token request รายคน ซึ่งแพงเกินไปสำหรับหน้าสรุป
      consent: /Tasks\.ReadWrite/i.test(scope),
      linked: !!scope,
      cards,
      tasks: rows.filter((r) => r.owner_upn.toLowerCase() === upn).length,
      lastSync: last ? new Date(last).toISOString() : null,
    };
  });

  /* จัดกลุ่มตาม เจ้าของ + ที่มา + วัน — หน่วยเดียวกับที่คนตัดสินใจว่า "กองนี้ผิด" */
  const groups = new Map<
    string,
    { owner: string; source: string; day: string; ids: number[]; items: Row[] }
  >();
  for (const r of rows) {
    const source = r.source || "(ไม่ระบุที่มา)";
    const day = bkkDay(r.created_at);
    const key = `${r.owner_upn}|${source}|${day}`;
    const g = groups.get(key) || { owner: r.owner_upn, source, day, ids: [], items: [] };
    g.ids.push(r.id);
    g.items.push(r);
    groups.set(key, g);
  }

  return NextResponse.json({
    perms: gate.perms,
    users,
    total: rows.length,
    groups: [...groups.values()]
      .sort((a, b) => (a.day === b.day ? b.ids.length - a.ids.length : b.day.localeCompare(a.day)))
      .map((g) => ({
        key: `${g.owner}|${g.source}|${g.day}`,
        owner: g.owner,
        source: g.source,
        day: g.day,
        n: g.ids.length,
        ids: g.ids,
        items: g.items.map((r) => ({
          id: r.id,
          title: r.title,
          responsible: r.responsible || "",
          status: r.status,
          due: r.due,
        })),
      })),
  });
}

export async function POST(req: Request) {
  const gate = await guard(req, "todo.manage");
  if (!gate.ok) return gate.response;
  try {
    assertConfigured();
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 503 });
  }

  let body: { action?: string; upn?: string; on?: boolean; ids?: number[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad body" }, { status: 400 });
  }
  const upn = (body.upn || "").trim().toLowerCase();
  if (!upn) return NextResponse.json({ error: "upn required" }, { status: 400 });

  try {
    if (body.action === "toggle") {
      await setTodoSyncOn(upn, !!body.on);
      return NextResponse.json({ ok: true, on: !!body.on, consent: await hasTasksConsent(upn) });
    }
    if (body.action === "sync") {
      return NextResponse.json(await syncTodoForUser(upn));
    }
    if (body.action === "delete") {
      const ids = (body.ids || []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
      if (!ids.length) return NextResponse.json({ error: "ids required" }, { status: 400 });
      const res = await deleteTasksEverywhere(upn, ids);
      console.warn(`[todo-manage] ${gate.upn} ลบงาน ${res.removed} ใบของ ${upn}`);
      return NextResponse.json({ ok: true, ...res });
    }
    return NextResponse.json({ error: "unknown action" }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: String(e).slice(0, 300) }, { status: 500 });
  }
}
