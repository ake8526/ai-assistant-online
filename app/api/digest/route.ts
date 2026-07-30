import { NextResponse } from "next/server";
import { assertConfigured } from "@/lib/supabaseServer";
import { buildDigest } from "@/lib/digest";

export const maxDuration = 60;
export type { Story } from "@/lib/digest";

export async function GET(req: Request) {
  try {
    assertConfigured();
    const upn = (new URL(req.url).searchParams.get("upn") || "").toLowerCase().trim();
    if (!upn) return NextResponse.json({ error: "upn required" }, { status: 400 });

    const { stories, skipped, note } = await buildDigest(upn);
    return NextResponse.json({ ok: true, user: upn, count: stories.length, stories, skipped, ...(note ? { note } : {}) });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
