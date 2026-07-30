import { NextResponse } from "next/server";
import { AuthError, requireUser } from "@/lib/auth";
import { resolveResponsible } from "@/lib/followup";
import { addTask, listTasks } from "@/lib/store";
import { assertConfigured } from "@/lib/supabaseServer";
import { normalizeDue } from "@/lib/time";

// GET ?status= → list the caller's tasks
export async function GET(req: Request) {
  try {
    assertConfigured();
    const upn = await requireUser(req);
    const status = new URL(req.url).searchParams.get("status") || undefined;
    return NextResponse.json({ tasks: await listTasks(upn, status) });
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 401 });
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

// POST { title, detail?, responsible?, due? } → add a task
export async function POST(req: Request) {
  try {
    assertConfigured();
    const upn = await requireUser(req);
    const body = await req.json();
    const title = String(body.title || "").trim();
    if (!title) return NextResponse.json({ error: "title required" }, { status: 400 });
    const responsible = String(body.responsible || "");
    const id = await addTask({
      owner_upn: upn,
      title,
      detail: String(body.detail || ""),
      responsible,
      responsible_upn: await resolveResponsible(responsible),
      due: normalizeDue(body.due),
      source: "manual",
    });
    return NextResponse.json({ id });
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 401 });
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
