import { NextResponse } from "next/server";
import { AuthError, checkCronSecret, requireUser } from "@/lib/auth";
import { buildForToday, runForUser } from "@/lib/brief";
import { isDueNow, markSent } from "@/lib/notify";
import { admin, assertConfigured } from "@/lib/supabaseServer";

export const maxDuration = 300;

async function linkedUsers(): Promise<string[]> {
  const { data } = await admin.from("line_links").select("upn");
  return (data || []).map((r) => r.upn);
}

// POST/GET — build + deliver the morning brief.
// Cron mode (?key=CRON_SECRET): run for every linked user, push to LINE.
// User mode (Bearer token): build the caller's brief and return the text.
export async function POST(req: Request) {
  return run(req);
}

export async function GET(req: Request) {
  return run(req);
}

async function run(req: Request) {
  try {
    assertConfigured();
    if (checkCronSecret(req)) {
      // `force=1` bypasses the per-user schedule (manual/test run for everyone).
      const force = new URL(req.url).searchParams.get("force") === "1";
      const results: Record<string, string> = {};
      for (const upn of await linkedUsers()) {
        try {
          if (!force && !(await isDueNow(upn, "brief"))) {
            results[upn] = "skip (not due)";
            continue;
          }
          await runForUser(upn);
          await markSent(upn, "brief");
          results[upn] = "delivered";
        } catch (e) {
          results[upn] = `ERROR: ${String(e).slice(0, 150)}`;
        }
      }
      return NextResponse.json({ ok: true, results });
    }
    const upn = await requireUser(req);
    const text = await buildForToday(upn);
    return NextResponse.json({ ok: true, brief: text });
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 401 });
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
