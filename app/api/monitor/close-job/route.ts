import { NextResponse } from "next/server";
import { guard } from "@/lib/guard";
import { admin, assertConfigured } from "@/lib/supabaseServer";
import { clearInflight } from "@/lib/notify";
import { clearDigestClaim } from "@/lib/digestKick";

// Close out one dead job from /monitor/log.
//
// There is nothing to "cancel": a job with no stage for minutes is not running,
// it is gone. What it can still leave behind are the locks it took on the way —
// the news in-flight flag, the digest push claim — which quietly block the next
// attempt. So this releases those, and writes a closing line into the job's own
// trace: the history stays, and the job stops counting as unexplained.
export const dynamic = "force-dynamic";

/** A trace that has moved in this window may genuinely still be working. */
const STILL_RUNNING_MS = 45_000;

export async function POST(req: Request) {
  const gate = await guard(req, "jobs.stop");
  if (!gate.ok) return gate.response;

  try {
    assertConfigured();
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 503 });
  }

  let body: { traceId?: string };
  try {
    body = (await req.json()) as { traceId?: string };
  } catch {
    return NextResponse.json({ error: "bad body" }, { status: 400 });
  }
  const traceId = (body.traceId || "").trim();
  if (!traceId) return NextResponse.json({ error: "traceId required" }, { status: 400 });

  const { data, error } = await admin
    .from("agent_traces")
    .select("id,trace_id,upn,channel,step,status,seq,created_at")
    .eq("trace_id", traceId)
    .order("seq", { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows = (data || []) as {
    id: number;
    upn: string | null;
    channel: string | null;
    step: string;
    status: string;
    seq: number;
    created_at: string;
  }[];
  if (!rows.length) return NextResponse.json({ error: "ไม่พบงานนี้" }, { status: 404 });

  const last = rows[rows.length - 1];
  const finished = rows.some((r) => r.step === "reply" || r.step === "error" || r.status === "error");
  if (finished) return NextResponse.json({ ok: true, note: "งานนี้จบไปแล้ว ไม่มีอะไรต้องปิด" });

  const quietMs = Date.now() - Date.parse(last.created_at);
  if (quietMs < STILL_RUNNING_MS) {
    // Refuse rather than kill something mid-flight — the caller sees a job that
    // is still moving and can try again in a moment.
    return NextResponse.json(
      { error: "งานนี้ยังทำงานอยู่ (เพิ่งขยับเมื่อไม่ถึง 45 วินาที) — รอให้จบก่อนครับ" },
      { status: 409 }
    );
  }

  const upn = last.upn || "";
  const released: string[] = [];
  if (upn) {
    for (const kind of ["news", "brief"] as const) {
      try {
        await clearInflight(upn, kind);
        released.push(kind);
      } catch {
        /* best effort — a lock left behind is not worth failing the close */
      }
    }
    try {
      await clearDigestClaim(upn);
      released.push("digest-claim");
    } catch {
      /* ignore */
    }
  }

  await admin.from("agent_traces").insert({
    trace_id: traceId,
    upn: last.upn,
    channel: last.channel,
    step: "error",
    status: "error",
    label: `ปิดงานค้างด้วยมือจากหน้า Log · ไม่ได้ทำงานอยู่แล้ว (เงียบ ${Math.round(quietMs / 60000)} นาที)`,
    seq: last.seq + 1,
    ms: 0,
  });

  return NextResponse.json({ ok: true, released, quietMinutes: Math.round(quietMs / 60000) });
}
