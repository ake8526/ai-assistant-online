import { NextResponse } from "next/server";
import { checkCronSecret } from "@/lib/auth";
import { checkDue } from "@/lib/followup";
import { assertConfigured } from "@/lib/supabaseServer";

export const maxDuration = 60;

// POST/GET ?key=CRON_SECRET — remind about overdue tasks (owner + responsible person)
export async function POST(req: Request) {
  return run(req);
}

export async function GET(req: Request) {
  return run(req);
}

async function run(req: Request) {
  try {
    assertConfigured();
    if (!checkCronSecret(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const reminded = await checkDue();
    return NextResponse.json({ ok: true, reminded });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
