/**
 * Full fresh-start for LINE QA: unlink + clear onboarding/prefs + welcome like new follow.
 * Usage: npx tsx scripts/reset-line-as-new-friend.ts ake
 */
import fs from "fs";
import path from "path";

function loadEnvLocal() {
  const p = path.join(process.cwd(), ".env.local");
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    if (!process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
}

async function main() {
  loadEnvLocal();
  const q = (process.argv[2] || "ake").trim().toLowerCase();
  const { admin, assertConfigured } = await import("../lib/supabaseServer");
  const { pushLineMessages } = await import("../lib/line");
  const { deleteSetting } = await import("../lib/store");
  const { resetNewsOnboarding } = await import("../lib/newsPrefs");
  assertConfigured();

  const { data: rows, error } = await admin
    .from("line_links")
    .select("upn, display_name, line_user_id");
  if (error) throw error;

  const hit = (rows || []).find((r) => {
    const upn = String(r.upn || "").toLowerCase();
    const dn = String(r.display_name || "").toLowerCase();
    return upn === q || upn.startsWith(q + "@") || dn.includes(q) || upn.includes(q);
  });
  if (!hit?.line_user_id || !hit.upn) {
    console.error(`No line_links match for “${q}”. Known:`);
    for (const r of rows || []) console.error(`  ${r.display_name} · ${r.upn}`);
    process.exit(1);
  }

  const upn = String(hit.upn);
  const lineUserId = String(hit.line_user_id);
  console.log(`Full reset as new friend: ${hit.display_name} · ${upn} · ${lineUserId}`);

  await resetNewsOnboarding(upn);
  console.log("Reset news onboarding prefs");

  const clearKeys = [
    "_line_draft",
    "_line_ctx",
    "_line_news_onboarding",
    "news_onboarding_done",
    "news_interested",
    "news_topics",
    "news_count",
    "news_enabled",
    "news_time",
    "news_days",
    "brief_enabled",
    "brief_time",
    "brief_days",
    "meeting_summary_enabled",
    "meeting_summary_line",
  ];
  for (const key of clearKeys) {
    try {
      await deleteSetting(upn, key);
    } catch {
      /* ignore */
    }
  }
  console.log("Cleared LINE settings keys");

  const { error: delErr } = await admin.from("line_links").delete().eq("upn", upn);
  if (delErr) throw delErr;
  console.log("Unlinked from line_links");

  try {
    await admin.from("oauth_tokens").delete().eq("owner_upn", upn.toLowerCase()).eq("provider", "microsoft");
    console.log("Cleared Microsoft calendar token (for fresh calendar onboarding test)");
  } catch {
    /* ignore */
  }

  const liffId = process.env.NEXT_PUBLIC_LIFF_ID || "2010856732-BFseuR2p";
  const linkUrl = `https://liff.line.me/${liffId}`;
  const accountUrl = `${(process.env.NEXT_PUBLIC_APP_BASE_URL || "https://ktis-ai-assistant.vercel.app").replace(/\/$/, "")}/account`;

  await pushLineMessages(lineUserId, [
    {
      type: "text",
      text:
        "🔄 เริ่มทดสอบใหม่จากศูนย์ครับ\n\n" +
        "ลำดับที่ต้องทำ:\n" +
        "1️⃣ กดปุ่ม “ผูกบัญชี” ด้านล่าง → ล็อกอิน M365\n" +
        "2️⃣ ตอบคำถามตั้งค่าข่าว → ผูก YouTube/RSS → อนุญาตปฏิทิน → ตั้ง Morning Brief\n" +
        "3️⃣ เสร็จแล้วลองสั่ง “ตารางวันนี้” หรือ “ข่าววันนี้”\n\n" +
        `หน้าจัดการบัญชี: ${accountUrl}`,
    },
    {
      type: "template",
      altText: "ผูกบัญชีเพื่อใช้งาน",
      template: {
        type: "buttons",
        text: "ผูกบัญชีเพื่อใช้งาน\nกดปุ่มด้านล่างเพื่อผูกบัญชี Microsoft 365 ของคุณ",
        actions: [{ type: "uri", label: "ผูกบัญชี", uri: linkUrl }],
      },
    },
  ]);
  console.log("Pushed checklist + ผูกบัญชี button");
  console.log("Ready — complete steps 1–3 in LINE, then we continue testing commands.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
