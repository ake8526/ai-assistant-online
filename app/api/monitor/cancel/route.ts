import { NextResponse } from "next/server";
import { guard } from "@/lib/guard";
import { runWithTrace, trace } from "@/lib/trace";
import { admin, assertConfigured } from "@/lib/supabaseServer";
import { alreadySentToday, clearInflight, markSent, type NotifyKind } from "@/lib/notify";
import { PAUSABLE_JOBS, pauseJobs, pauseState, resumeJobs, type PausableJob } from "@/lib/opsPause";

// Stop pending / looping scheduled work — the button behind /monitor "หยุดงานค้าง".
//
// Why this exists: the morning tick retries until the day's delivery is marked
// sent. When the send itself keeps failing (LINE push quota, Graph outage) the
// retry never converges and burns Graph + LLM calls from 05:30 to 20:55 for
// every linked user. There was no way to stop it short of a redeploy.
//
// What it does: marks today's morning deliveries as done for the chosen users
// and releases their in-flight locks, so the scheduler stops picking them up.
// It does NOT delete anything — tomorrow's run is unaffected, and the user can
// still ask for the brief by hand in LINE ("สรุปตารางเช้า").
export const dynamic = "force-dynamic";

async function linkedUsers(): Promise<string[]> {
  const { data } = await admin.from("line_links").select("upn");
  return (data || []).map((r: { upn: string }) => r.upn);
}

export async function POST(req: Request) {
  // Stopping the day's deliveries is a separate right from reading the log.
  const gate = await guard(req, "jobs.stop");
  if (!gate.ok) return gate.response;
  const caller = gate.upn;

  try {
    assertConfigured();
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 503 });
  }

  const url = new URL(req.url);

  // resume=1 — undo a pause without waiting for it to lapse.
  if (url.searchParams.get("resume") === "1") {
    await resumeJobs();
    await runWithTrace({ upn: caller.includes("@") ? caller : undefined, channel: "web" }, async () => {
      trace("receive", "เปิดงาน cron กลับจากหน้า Monitor");
      trace("reply", "เปิดงานที่หยุดไว้กลับแล้ว");
    });
    return NextResponse.json({ ok: true, resumed: true });
  }

  // scope=me → only the caller. scope=all (default) → every linked user, which is
  // what "งานค้างทั้งห้อง" means when a shared failure is looping for everyone.
  const scope = (url.searchParams.get("scope") || "all").toLowerCase();
  // jobs=… — also silence the polling jobs (they have no "sent today" flag to
  // set, so they need their own pause). Defaults to all three when jobs=1.
  const jobsParam = (url.searchParams.get("jobs") || "").toLowerCase();
  const pausedJobs: PausableJob[] = !jobsParam
    ? []
    : jobsParam === "1" || jobsParam === "all"
      ? PAUSABLE_JOBS.map((j) => j.key)
      : (jobsParam.split(",").map((s) => s.trim()) as PausableJob[]).filter((j) =>
          PAUSABLE_JOBS.some((p) => p.key === j)
        );
  const kindParam = (url.searchParams.get("kind") || "both").toLowerCase();
  // kind=none — pause the named jobs and touch nobody's deliveries. Stopping one
  // polling job from the activity table must not also mark everyone's morning
  // as sent, which is what this route does for the big red button.
  const kinds: NotifyKind[] =
    kindParam === "none"
      ? []
      : kindParam === "brief"
        ? ["brief"]
        : kindParam === "news"
          ? ["news"]
          : ["brief", "news"];

  const users = scope === "me" && caller.includes("@") ? [caller] : await linkedUsers();

  const stopped: Record<string, string[]> = {};
  let count = 0;
  for (const upn of users) {
    for (const kind of kinds) {
      try {
        // Already delivered today → nothing pending; leave the real timestamp alone.
        if (await alreadySentToday(upn, kind)) continue;
        await markSent(upn, kind); // stamps today → isDueNow() goes false
        await clearInflight(upn, kind);
        (stopped[upn] ||= []).push(kind);
        count++;
      } catch (e) {
        (stopped[upn] ||= []).push(`${kind}:ERROR ${String(e).slice(0, 80)}`);
      }
    }
  }

  // Merge with whatever is already paused — pausing one job must not quietly
  // release another.
  const current = await pauseState();
  const merged = [...new Set([...(current?.jobs || []), ...pausedJobs])];
  const paused = pausedJobs.length ? await pauseJobs(merged) : null;

  // Record it in the same trace log the monitor reads, so a stopped morning is
  // explainable later ("ทำไมวันนั้นไม่มีสรุปเช้า").
  await runWithTrace({ upn: caller.includes("@") ? caller : undefined, channel: "web" }, async () => {
    const names = pausedJobs
      .map((j) => PAUSABLE_JOBS.find((p) => p.key === j)?.label || j)
      .join(" · ");
    trace("receive", kinds.length ? "หยุดงานค้างจากหน้า Monitor" : `หยุดงานตั้งเวลาจากหน้า Monitor · ${names}`);
    const pausedNote = paused ? ` · พักงานตั้งเวลา ${names} ถึงเที่ยงคืน` : "";
    trace(
      "reply",
      kinds.length
        ? `หยุดแล้ว ${count} งาน · ${users.length} คน (${kinds.join("+")})${pausedNote}`
        : `พักงานตั้งเวลาแล้ว: ${names} (ถึงเที่ยงคืน)`
    );
  });

  return NextResponse.json({
    ok: true,
    scope,
    kinds,
    users: users.length,
    stopped,
    count,
    paused,
  });
}
