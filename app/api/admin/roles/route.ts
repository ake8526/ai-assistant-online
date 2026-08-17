import { NextResponse } from "next/server";
import { guard } from "@/lib/guard";
import { runWithTrace, trace } from "@/lib/trace";
import { assertConfigured } from "@/lib/supabaseServer";
import {
  loadRoles,
  saveRoles,
  rootAdmins,
  openPerms,
  setOpenPerms,
  openablePerms,
  PERMS,
  type Perm,
} from "@/lib/roles";

// Read and edit who may use the ops pages. Only holders of "admin" get here.
export const dynamic = "force-dynamic";

const validPerm = (p: unknown): p is Perm => PERMS.some((x) => x.key === p);

export async function GET(req: Request) {
  const gate = await guard(req, "admin");
  if (!gate.ok) return gate.response;
  try {
    assertConfigured();
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 503 });
  }
  return NextResponse.json({
    roles: await loadRoles(),
    roots: rootAdmins(),
    perms: PERMS,
    open: await openPerms(),
    openable: openablePerms(),
    you: gate.upn,
  });
}

export async function POST(req: Request) {
  const gate = await guard(req, "admin");
  if (!gate.ok) return gate.response;
  try {
    assertConfigured();
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 503 });
  }

  let body: { upn?: string; perms?: unknown; open?: unknown };
  try {
    body = (await req.json()) as { upn?: string; perms?: unknown; open?: unknown };
  } catch {
    return NextResponse.json({ error: "bad body" }, { status: 400 });
  }

  // { open: [...] } — which permissions every signed-in account holds already.
  if (Array.isArray(body.open)) {
    const saved = await setOpenPerms(body.open.map(String));
    await runWithTrace({ upn: gate.upn.includes("@") ? gate.upn : undefined, channel: "web" }, async () => {
      trace("receive", "แก้สิทธิ์เปิดให้ทุกคนจากหน้า Monitor");
      trace("reply", saved.length ? `เปิดให้ทุกคน: ${saved.join(",")}` : "ปิดสิทธิ์เปิดให้ทุกคนทั้งหมด");
    });
    return NextResponse.json({ ok: true, open: saved });
  }

  const upn = (body.upn || "").trim().toLowerCase();
  if (!upn.includes("@")) {
    return NextResponse.json({ error: "ต้องเป็นอีเมลเต็ม เช่น somchai@ktisgroup.com" }, { status: 400 });
  }
  const perms = Array.isArray(body.perms) ? body.perms.filter(validPerm) : [];

  const map = await loadRoles();
  const losesAdmin = (map[upn] || []).includes("admin") && !perms.includes("admin");
  if (perms.length) map[upn] = perms;
  else delete map[upn];

  // Only guard the case that can actually lock everyone out: demoting the last
  // admin. Granting rights when nobody is set up yet must stay possible, or the
  // very first admin could never be created.
  if (losesAdmin && !rootAdmins().length) {
    const adminsLeft = Object.values(map).filter((list) => list.includes("admin")).length;
    if (adminsLeft === 0) {
      return NextResponse.json(
        { error: "ต้องเหลือผู้ดูแลอย่างน้อย 1 คน — ตั้งสิทธิ์ «จัดการสิทธิ์» ให้คนอื่นก่อน" },
        { status: 400 }
      );
    }
  }

  await saveRoles(map);

  await runWithTrace({ upn: gate.upn.includes("@") ? gate.upn : undefined, channel: "web" }, async () => {
    trace("receive", "แก้สิทธิ์ผู้ใช้จากหน้า Monitor");
    // Stage labels stay non-PII: the account is named by its local part only.
    const who = upn.split("@")[0];
    trace("reply", perms.length ? `ให้สิทธิ์ ${who} · ${perms.join(",")}` : `ถอนสิทธิ์ ${who}`);
  });

  return NextResponse.json({ ok: true, roles: await loadRoles() });
}
