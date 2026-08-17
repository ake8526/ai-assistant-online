import { NextResponse } from "next/server";
import { requireUser, AuthError } from "@/lib/auth";
import { runWithTrace, trace } from "@/lib/trace";
import { admin, assertConfigured } from "@/lib/supabaseServer";
import { alreadySentToday, clearInflight, markSent, type NotifyKind } from "@/lib/notify";

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

const REQUIRE_LOGIN = process.env.NODE_ENV === "production";

async function linkedUsers(): Promise<string[]> {
  const { data } = await admin.from("line_links").select("upn");
  return (data || []).map((r: { upn: string }) => r.upn);
}

export async function POST(req: Request) {
  let caller = "dev";
  if (REQUIRE_LOGIN) {
    try {
      caller = await requireUser(req);
    } catch (e) {
      if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 401 });
      return NextResponse.json({ error: "auth failed" }, { status: 401 });
    }
  }

  try {
    assertConfigured();
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 503 });
  }

  const url = new URL(req.url);
  // scope=me → only the caller. scope=all (default) → every linked user, which is
  // what "งานค้างทั้งห้อง" means when a shared failure is looping for everyone.
  const scope = (url.searchParams.get("scope") || "all").toLowerCase();
  const kindParam = (url.searchParams.get("kind") || "both").toLowerCase();
  const kinds: NotifyKind[] =
    kindParam === "brief" ? ["brief"] : kindParam === "news" ? ["news"] : ["brief", "news"];

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

  // Record it in the same trace log the monitor reads, so a stopped morning is
  // explainable later ("ทำไมวันนั้นไม่มีสรุปเช้า").
  await runWithTrace({ upn: caller.includes("@") ? caller : undefined, channel: "web" }, async () => {
    trace("receive", "หยุดงานค้างจากหน้า Monitor");
    trace("reply", `หยุดแล้ว ${count} งาน · ${users.length} คน (${kinds.join("+")})`);
  });

  return NextResponse.json({ ok: true, scope, kinds, users: users.length, stopped, count });
}
