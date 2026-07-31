import { NextResponse } from "next/server";
import { AuthError, resolveUser } from "@/lib/auth";
import { sendLine } from "@/lib/line";
import { admin, assertConfigured } from "@/lib/supabaseServer";

export async function GET(req: Request) {
  try {
    assertConfigured();
    const upn = await resolveUser(req);
    const { data, error } = await admin
      .from("feeds")
      .select("*")
      .eq("owner_upn", upn)
      .order("created_at", { ascending: true });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json(data || []);
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
    const kind = String(body.kind || "").toLowerCase();
    if (!["rss", "youtube", "facebook"].includes(kind)) {
      return NextResponse.json({ error: "kind must be rss|youtube|facebook" }, { status: 400 });
    }
    const ref = String(body.ref || "").trim() || (kind === "youtube" ? "subscriptions" : "");
    if (kind === "rss" && !ref.startsWith("http")) {
      return NextResponse.json({ error: "RSS ref must be a URL" }, { status: 400 });
    }
    if (kind === "facebook" && !ref) {
      return NextResponse.json({ error: "facebook ref (page URL or id) required" }, { status: 400 });
    }
    const label = String(body.label || "").trim();
    const { data, error } = await admin
      .from("feeds")
      .upsert(
        { owner_upn: upn, kind, ref, label, created_at: new Date().toISOString() },
        { onConflict: "owner_upn,kind,ref" }
      )
      .select()
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    let lineNotified = false;
    if (body.notify && Array.isArray(body.items) && body.items.length) {
      const source = label || (kind === "facebook" ? "Facebook" : "RSS");
      const lines = [
        kind === "facebook" ? "📘 เริ่มติดตามเพจ Facebook แล้ว" : "📰 เริ่มติดตามลิงก์ข่าว/บล็อก แล้ว",
        "",
        `แหล่ง: ${source}`,
        `ลิงก์: ${ref}`,
        "",
        "รายการล่าสุดที่จะนำมาสรุป:",
        ...body.items.slice(0, 5).map((it: { title?: string }, i: number) =>
          `${i + 1}) ${String(it?.title || "(ไม่มีหัวข้อ)").slice(0, 120)}`
        ),
        "",
        "ถามในแชทได้ว่า “มีข่าวอะไรบ้าง” หรือรอสรุปอัตโนมัติตามเวลาที่ตั้งไว้",
      ];
      try {
        await sendLine(upn, "", lines.join("\n"));
        lineNotified = true;
      } catch {
        /* not linked or push failed — feed still saved */
      }
    }

    return NextResponse.json({ ...data, lineNotified });
  } catch (e) {
    const status = e instanceof AuthError ? 401 : 500;
    return NextResponse.json({ error: String(e instanceof AuthError ? e.message : e) }, { status });
  }
}

export async function DELETE(req: Request) {
  try {
    assertConfigured();
    const upn = await resolveUser(req);
    const id = new URL(req.url).searchParams.get("id");
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
    const { error } = await admin.from("feeds").delete().eq("owner_upn", upn).eq("id", Number(id));
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    const status = e instanceof AuthError ? 401 : 500;
    return NextResponse.json({ error: String(e instanceof AuthError ? e.message : e) }, { status });
  }
}
