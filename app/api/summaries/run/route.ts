import { NextResponse } from "next/server";
import { AuthError, checkCronSecret, requireUser } from "@/lib/auth";
import { runScheduledForUser } from "@/lib/meetings";
import { admin, assertConfigured } from "@/lib/supabaseServer";
import { runWithTrace, trace } from "@/lib/trace";
import { jobSkipReason } from "@/lib/jobHealth";
import { getSetting, setSetting } from "@/lib/store";

// One cron run at a time. A pass can take minutes (a transcript per meeting,
// an LLM call each), and the scheduler fires every ten — an overlap meant two
// passes reading the same "not summarised yet" state.
const LOCK_KEY = "summaries_inflight";
const LOCK_TTL_MS = 12 * 60_000;

async function takeLock(): Promise<boolean> {
  const held = await getSetting("_ops", LOCK_KEY);
  const t = parseInt(held || "", 10);
  if (Number.isFinite(t) && Date.now() - t < LOCK_TTL_MS) return false;
  await setSetting("_ops", LOCK_KEY, String(Date.now()));
  return true;
}

const releaseLock = () => setSetting("_ops", LOCK_KEY, "");

export const maxDuration = 300;

async function linkedUsers(): Promise<string[]> {
  const { data } = await admin.from("line_links").select("upn");
  return (data || []).map((r) => r.upn);
}

// POST/GET — summarize recently-ended meetings (with transcripts) and deliver via LINE.
// Cron mode (?key=CRON_SECRET): all linked users. User mode (Bearer): just the caller.
export async function POST(req: Request) {
  return run(req);
}

export async function GET(req: Request) {
  return run(req);
}

async function run(req: Request) {
  let locked = false;
  try {
    assertConfigured();
    let users: string[];
    let channel: string;
    if (checkCronSecret(req)) {
      // Paused from /monitor/log. A signed-in user asking for it by hand is
      // never blocked — the pause is for the scheduler only.
      const skip = await jobSkipReason("summaries");
      if (skip) return NextResponse.json({ ok: true, skipped: skip });
      if (!(await takeLock())) return NextResponse.json({ ok: true, skipped: "another run in progress" });
      locked = true;
      users = await linkedUsers();
      channel = "cron";
    } else {
      users = [await requireUser(req)];
      channel = "web";
    }
    const results: Record<string, unknown> = {};
    for (const upn of users) {
      try {
        results[upn] = await runWithTrace({ upn, channel }, async () => {
          trace("receive", channel === "cron" ? "cron · สรุปประชุม" : "เว็บ · สรุปประชุม");
          const res = await runScheduledForUser(upn);
          const quiet = !res.summarized && !res.tasksAdded;
          // Say how many were left alone because they were already summarised —
          // when duplicates come back, this line is the first place to look.
          const skipNote = res.skipped ? ` · ข้ามที่สรุปแล้ว ${res.skipped}` : "";
          trace(
            "reply",
            quiet
              ? `ไม่มีประชุมให้สรุป${skipNote}`
              : `สรุป ${res.summarized} · งาน ${res.tasksAdded}${skipNote}`,
            quiet ? "skip" : "done"
          );
          return res;
        });
      } catch (e) {
        results[upn] = `ERROR: ${String(e).slice(0, 150)}`;
      }
    }
    return NextResponse.json({ ok: true, results });
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 401 });
    return NextResponse.json({ error: String(e) }, { status: 500 });
  } finally {
    // Always hand the lock back — a crash must not block the next ten minutes.
    if (locked) {
      try {
        await releaseLock();
      } catch {
        /* the TTL will clear it */
      }
    }
  }
}
