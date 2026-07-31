import { NextResponse } from "next/server";
import { AuthError, resolveUser } from "@/lib/auth";
import { admin, assertConfigured } from "@/lib/supabaseServer";

const CAPS = ["read_tracking", "src_rss", "src_youtube", "src_facebook"] as const;

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
    const upn = await resolveUser(req);
    return NextResponse.json(await currentConsents(upn));
  } catch (e) {
    const status = e instanceof AuthError ? 401 : 500;
    return NextResponse.json({ error: String(e instanceof AuthError ? e.message : e) }, { status });
  }
}

export async function POST(req: Request) {
  try {
    assertConfigured();
    const upn = await resolveUser(req);
    const body = await req.json();
    if (!CAPS.includes(body.capability)) {
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
    const status = e instanceof AuthError ? 401 : 500;
    return NextResponse.json({ error: String(e instanceof AuthError ? e.message : e) }, { status });
  }
}
