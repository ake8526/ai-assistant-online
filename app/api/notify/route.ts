import { NextResponse } from "next/server";
import { AuthError, resolveUser } from "@/lib/auth";
import { assertConfigured } from "@/lib/supabaseServer";
import { getNotifyConfig, saveNotifyKind, type KindConfig, type NotifyKind } from "@/lib/notify";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

export async function GET(req: Request) {
  try {
    assertConfigured();
    const upn = await resolveUser(req);
    return NextResponse.json(await getNotifyConfig(upn), { headers: NO_STORE });
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
    const kind = String(body.kind || "") as NotifyKind;
    if (kind !== "brief" && kind !== "news") {
      return NextResponse.json({ error: "kind (brief|news) required" }, { status: 400 });
    }
    const patch: Partial<KindConfig> = {};
    if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
    if (typeof body.time === "string") patch.time = body.time;
    if (Array.isArray(body.days)) patch.days = body.days.map((n: unknown) => Number(n));
    if (body.count !== undefined) patch.count = Number(body.count);
    await saveNotifyKind(upn, kind, patch);
    return NextResponse.json(await getNotifyConfig(upn), { headers: NO_STORE });
  } catch (e) {
    const status = e instanceof AuthError ? 401 : 500;
    return NextResponse.json({ error: String(e instanceof AuthError ? e.message : e) }, { status });
  }
}
