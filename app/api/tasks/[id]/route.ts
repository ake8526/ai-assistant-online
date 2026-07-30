import { NextResponse } from "next/server";
import { AuthError, requireUser } from "@/lib/auth";
import { updateTaskStatus } from "@/lib/store";
import { admin, assertConfigured } from "@/lib/supabaseServer";

// PATCH { status } → update a task's status (done | pending | cancelled)
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertConfigured();
    const upn = await requireUser(req);
    const { id } = await params;
    const taskId = Number(id);
    const body = await req.json();
    const status = String(body.status || "");
    if (!["pending", "done", "cancelled", "overdue"].includes(status)) {
      return NextResponse.json({ error: "invalid status" }, { status: 400 });
    }
    // only the owner may change their task
    const { data } = await admin.from("tasks").select("owner_upn").eq("id", taskId).maybeSingle();
    if (!data) return NextResponse.json({ error: "task not found" }, { status: 404 });
    if (data.owner_upn !== upn) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    await updateTaskStatus(taskId, status);
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 401 });
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
