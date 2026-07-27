import { NextResponse } from "next/server";
import { admin, assertConfigured } from "@/lib/supabaseServer";

function getUpn(req: Request): string {
  return (new URL(req.url).searchParams.get("upn") || "").toLowerCase().trim();
}

export async function GET(req: Request) {
  try {
    assertConfigured();
    const upn = getUpn(req);
    if (!upn) return NextResponse.json({ error: "upn required" }, { status: 400 });
    const { data, error } = await admin
      .from("feeds")
      .select("*")
      .eq("owner_upn", upn)
      .order("created_at", { ascending: true });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json(data || []);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    assertConfigured();
    const upn = getUpn(req);
    const body = await req.json();
    const kind = String(body.kind || "").toLowerCase();
    if (!upn || !["rss", "youtube", "facebook"].includes(kind)) {
      return NextResponse.json({ error: "kind must be rss|youtube|facebook" }, { status: 400 });
    }
    const ref = String(body.ref || "").trim() || (kind === "youtube" ? "subscriptions" : "");
    if (kind === "rss" && !ref.startsWith("http")) {
      return NextResponse.json({ error: "RSS ref must be a URL" }, { status: 400 });
    }
    const { data, error } = await admin
      .from("feeds")
      .upsert(
        { owner_upn: upn, kind, ref, label: String(body.label || "").trim(), created_at: new Date().toISOString() },
        { onConflict: "owner_upn,kind,ref" }
      )
      .select()
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    assertConfigured();
    const upn = getUpn(req);
    const id = new URL(req.url).searchParams.get("id");
    if (!upn || !id) return NextResponse.json({ error: "upn and id required" }, { status: 400 });
    const { error } = await admin.from("feeds").delete().eq("owner_upn", upn).eq("id", Number(id));
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
