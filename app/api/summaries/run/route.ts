import { NextResponse } from "next/server";
import { AuthError, checkCronSecret, requireUser } from "@/lib/auth";
import { runScheduledForUser } from "@/lib/meetings";
import { admin, assertConfigured } from "@/lib/supabaseServer";

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
  try {
    assertConfigured();
    let users: string[];
    if (checkCronSecret(req)) {
      users = await linkedUsers();
    } else {
      users = [await requireUser(req)];
    }
    const results: Record<string, unknown> = {};
    for (const upn of users) {
      try {
        results[upn] = await runScheduledForUser(upn);
      } catch (e) {
        results[upn] = `ERROR: ${String(e).slice(0, 150)}`;
      }
    }
    return NextResponse.json({ ok: true, results });
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 401 });
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
