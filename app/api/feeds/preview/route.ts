import { NextResponse } from "next/server";
import { parsePageRef, recentPosts, resolvePage, isConfigured as fbConfigured } from "@/lib/facebook";
import { fetchFeed } from "@/lib/rss";

export const dynamic = "force-dynamic";

// POST { url, kind? } → preview recent items before the user confirms follow.
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const url = String(body.url || "").trim();
    const kindHint = String(body.kind || "").toLowerCase();
    if (!url) return NextResponse.json({ error: "url required" }, { status: 400 });

    const looksFb = !!parsePageRef(url) || /facebook\.com|fb\.com/i.test(url);
    const kind = kindHint === "facebook" || (!kindHint && looksFb) ? "facebook" : "rss";

    if (kind === "facebook") {
      if (!fbConfigured()) {
        return NextResponse.json({
          ok: false,
          kind,
          error:
            "ยังไม่ได้ตั้ง FACEBOOK_APP_ID / FACEBOOK_APP_SECRET บนเซิร์ฟเวอร์ — ติดต่อแอดมินเพื่อเปิดดึงโพสต์เพจ",
        });
      }
      let pageName = url;
      try {
        const page = await resolvePage(url);
        if (page) pageName = page.name;
      } catch (e) {
        return NextResponse.json({ ok: false, kind, error: `หาเพจไม่เจอ: ${String(e).slice(0, 120)}` });
      }
      const items = await recentPosts(url, 5);
      if (!items.length) {
        return NextResponse.json({
          ok: false,
          kind,
          source: pageName,
          error:
            "ดึงโพสต์เพจไม่ได้ — Meta จำกัด Page Public Content Access (แอปต้องขอสิทธิ์นี้ หรือเป็นเพจที่ผูกกับแอป)",
        });
      }
      return NextResponse.json({
        ok: true,
        kind,
        source: pageName,
        items: items.map((it) => ({
          title: it.title,
          link: it.link,
          published: it.published,
          summary: it.summary.slice(0, 200),
        })),
      });
    }

    if (!/^https?:\/\//i.test(url)) {
      return NextResponse.json({ error: "RSS URL ต้องขึ้นต้นด้วย http:// หรือ https://" }, { status: 400 });
    }
    const items = await fetchFeed(url);
    if (!items.length) {
      return NextResponse.json({
        ok: false,
        kind: "rss",
        error: "ดึงฟีดไม่ได้ — ตรวจว่าลิงก์เป็น RSS/Atom จริง และเข้าถึงได้จากสาธารณะ",
      });
    }
    return NextResponse.json({
      ok: true,
      kind: "rss",
      source: items[0]?.source || url,
      items: items.slice(0, 5).map((it) => ({
        title: it.title,
        link: it.link,
        published: it.published,
        summary: it.summary.slice(0, 200),
      })),
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
