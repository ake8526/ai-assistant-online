import { NextResponse } from "next/server";
import { assertConfigured } from "@/lib/supabaseServer";
import { getNotifyConfig, saveNotifyKind, type KindConfig, type NotifyKind } from "@/lib/notify";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

function getUpn(req: Request): string {
  return (new URL(req.url).searchParams.get("upn") || "").toLowerCase().trim();
}

// GET ?upn= → current notification schedule (with defaults applied)
export async function GET(req: Request) {
  try {
    assertConfigured();
    const upn = getUpn(req);
    if (!upn) return NextResponse.json({ error: "upn required" }, { status: 400 });
    return NextResponse.json(await getNotifyConfig(upn), { headers: NO_STORE });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

// POST ?upn=  { kind: "brief"|"news", enabled?, time?, days? } → save one kind
export async function POST(req: Request) {
  try {
    assertConfigured();
    const upn = getUpn(req);
    const body = await req.json();
    const kind = String(body.kind || "") as NotifyKind;
    if (!upn || (kind !== "brief" && kind !== "news")) {
      return NextResponse.json({ error: "upn and kind (brief|news) required" }, { status: 400 });
    }
    const patch: Partial<KindConfig> = {};
    if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
    if (typeof body.time === "string") patch.time = body.time;
    if (Array.isArray(body.days)) patch.days = body.days.map((n: unknown) => Number(n));
    if (body.count !== undefined) patch.count = Number(body.count);
    await saveNotifyKind(upn, kind, patch);
    return NextResponse.json(await getNotifyConfig(upn), { headers: NO_STORE });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
