import { NextResponse } from "next/server";
import { admin, assertConfigured } from "@/lib/supabaseServer";

const CAPS = ["read_tracking", "src_rss", "src_youtube", "src_facebook"] as const;

function getUpn(req: Request): string {
  return (new URL(req.url).searchParams.get("upn") || "").toLowerCase().trim();
}

async function currentConsents(upn: string) {
  const { data } = await admin.from("consents").select("capability, granted").eq("owner_upn", upn);
  const map: Record<string, boolean> = {};
  CAPS.forEach((c) => (map[c] = false));
  (data || []).forEach((r: { capability: string; granted: boolean }) => (map[r.capability] = !!r.granted));
  return map;
}

export async function GET(req: Request) {
  try {
    assertConfigured();
    const upn = getUpn(req);
    if (!upn) return NextResponse.json({ error: "upn required" }, { status: 400 });
    return NextResponse.json(await currentConsents(upn));
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    assertConfigured();
    const upn = getUpn(req);
    const body = await req.json();
    if (!upn || !CAPS.includes(body.capability)) {
      return NextResponse.json({ error: "bad request" }, { status: 400 });
    }
    const { error } = await admin
      .from("consents")
      .upsert(
        { owner_upn: upn, capability: body.capability, granted: !!body.granted, updated_at: new Date().toISOString() },
        { onConflict: "owner_upn,capability" }
      );
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json(await currentConsents(upn));
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
