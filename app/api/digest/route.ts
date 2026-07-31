import { NextResponse } from "next/server";
import { AuthError, requireUserOrCron } from "@/lib/auth";
import { assertConfigured } from "@/lib/supabaseServer";
import { buildDigest } from "@/lib/digest";

export const maxDuration = 60;
export type { Story } from "@/lib/digest";

export async function GET(req: Request) {
  try {
    assertConfigured();
    const upn = await requireUserOrCron(req);
    const { stories, skipped, note } = await buildDigest(upn);
    return NextResponse.json({ ok: true, user: upn, count: stories.length, stories, skipped, ...(note ? { note } : {}) });
  } catch (e) {
    const status = e instanceof AuthError ? 401 : 500;
    return NextResponse.json({ error: String(e instanceof AuthError ? e.message : e) }, { status });
  }
}
