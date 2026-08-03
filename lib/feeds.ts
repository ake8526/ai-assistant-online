// Feed CRUD helpers — used by /api/feeds and LINE/web chat commands.
import { admin } from "@/lib/supabaseServer";
import { parsePageRef, recentPosts, resolvePage, isConfigured as fbConfigured } from "@/lib/facebook";
import { fetchFeed } from "@/lib/rss";

export type FeedKind = "rss" | "facebook" | "youtube";

export type FeedRow = {
  id: number;
  owner_upn: string;
  kind: string;
  ref: string;
  label: string;
  created_at?: string;
};

const CAP: Record<string, string> = {
  rss: "src_rss",
  facebook: "src_facebook",
  youtube: "src_youtube",
};

export async function listFeeds(upn: string, kinds?: FeedKind[]): Promise<FeedRow[]> {
  let q = admin.from("feeds").select("*").eq("owner_upn", upn).order("created_at", { ascending: true });
  if (kinds?.length) q = q.in("kind", kinds);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data || []) as FeedRow[];
}

/** User-managed sources on /consents (not YouTube OAuth). */
export async function listManagedFeeds(upn: string): Promise<FeedRow[]> {
  return listFeeds(upn, ["rss", "facebook"]);
}

export async function getFeed(upn: string, id: number): Promise<FeedRow | null> {
  const { data, error } = await admin
    .from("feeds")
    .select("*")
    .eq("owner_upn", upn)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as FeedRow) || null;
}

export async function grantFeedConsent(upn: string, kind: string): Promise<void> {
  const capability = CAP[kind];
  if (!capability) return;
  await admin.from("consents").upsert(
    { owner_upn: upn, capability, granted: true },
    { onConflict: "owner_upn,capability" }
  );
}

export function detectFeedKind(url: string, hint?: string): "rss" | "facebook" {
  const h = (hint || "").toLowerCase();
  if (h === "facebook" || h === "fb") return "facebook";
  if (h === "rss") return "rss";
  if (parsePageRef(url) || /facebook\.com|fb\.com/i.test(url)) return "facebook";
  return "rss";
}

export async function previewFeed(
  url: string,
  kindHint?: string
): Promise<{ ok: true; kind: "rss" | "facebook"; source: string; items: { title: string }[] } | { ok: false; error: string }> {
  const kind = detectFeedKind(url, kindHint);
  if (kind === "facebook") {
    if (!fbConfigured()) {
      return { ok: false, error: "ยังไม่ได้ตั้งค่า Facebook บนเซิร์ฟเวอร์" };
    }
    try {
      let source = url;
      const page = await resolvePage(url);
      if (page) source = page.name;
      const items = await recentPosts(url, 5);
      if (!items.length) {
        return { ok: false, error: "ดึงโพสต์เพจไม่ได้ — ตรวจลิงก์เพจหรือสิทธิ์แอป Meta" };
      }
      return { ok: true, kind, source, items: items.map((it) => ({ title: it.title })) };
    } catch (e) {
      return { ok: false, error: `หาเพจไม่เจอ: ${String(e).slice(0, 120)}` };
    }
  }
  if (!/^https?:\/\//i.test(url)) {
    return { ok: false, error: "ลิงก์ RSS ต้องขึ้นต้นด้วย http:// หรือ https://" };
  }
  try {
    const items = await fetchFeed(url);
    if (!items.length) {
      return { ok: false, error: "ดึงฟีดไม่ได้ — ตรวจว่าเป็นลิงก์ RSS/Atom จริง" };
    }
    return {
      ok: true,
      kind: "rss",
      source: items[0]?.source || url,
      items: items.slice(0, 5).map((it) => ({ title: it.title })),
    };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 150) };
  }
}

export async function upsertFeed(
  upn: string,
  kind: "rss" | "facebook",
  ref: string,
  label = ""
): Promise<FeedRow> {
  const { data, error } = await admin
    .from("feeds")
    .upsert(
      { owner_upn: upn, kind, ref, label, created_at: new Date().toISOString() },
      { onConflict: "owner_upn,kind,ref" }
    )
    .select()
    .single();
  if (error) throw new Error(error.message);
  await grantFeedConsent(upn, kind);
  return data as FeedRow;
}

export async function updateFeed(
  upn: string,
  id: number,
  patch: { label?: string; ref?: string }
): Promise<FeedRow | null> {
  const updates: Record<string, string> = {};
  if (typeof patch.label === "string") updates.label = patch.label.trim();
  if (typeof patch.ref === "string" && patch.ref.trim()) updates.ref = patch.ref.trim();
  if (!Object.keys(updates).length) return getFeed(upn, id);
  const { data, error } = await admin
    .from("feeds")
    .update(updates)
    .eq("owner_upn", upn)
    .eq("id", id)
    .select()
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as FeedRow) || null;
}

export async function deleteFeed(upn: string, id: number): Promise<boolean> {
  const { error } = await admin.from("feeds").delete().eq("owner_upn", upn).eq("id", id);
  if (error) throw new Error(error.message);
  return true;
}

export function formatFeedList(feeds: FeedRow[]): string {
  if (!feeds.length) return "ยังไม่มีแหล่งข่าวที่ติดตามครับ";
  return feeds
    .map((f, i) => {
      const kind = f.kind === "facebook" ? "Facebook" : "RSS";
      const name = (f.label || "").trim() || "(ไม่มีชื่อ)";
      return `${i + 1}) [${kind}] ${name}\n   ${f.ref}`;
    })
    .join("\n\n");
}

export function resolveFeedByIndexOrId(
  feeds: FeedRow[],
  params: { feed_id?: unknown; feed_index?: unknown; index?: unknown }
): FeedRow | null {
  const id = Number(params.feed_id);
  if (id) return feeds.find((f) => f.id === id) || null;
  const idx = Number(params.feed_index ?? params.index);
  if (idx >= 1 && idx <= feeds.length) return feeds[idx - 1];
  return null;
}
