/**
 * Push web setup TEST page to ake (preview topic picker + close on save/cancel).
 * Usage: npx tsx scripts/send-setup-test-to-ake.ts [optional-preview-base-url]
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
  const { pushLineMessages } = await import("../lib/line");

  const base = (process.argv[2] || process.env.NEXT_PUBLIC_APP_BASE_URL || "https://ktis-ai-assistant.vercel.app").replace(
    /\/$/,
    ""
  );
  const liffId = process.env.NEXT_PUBLIC_LIFF_ID || "2010856732-BFseuR2p";
  const liffUrl = `https://liff.line.me/${liffId}?view=setup-test`;
  const testUrl = liffUrl;
  const lineUserId = "U1faefe8ddeaec9f6aba2645f604b0dc6";

  await pushLineMessages(lineUserId, [
    {
      type: "text",
      text:
        "✅ deploy แล้ว — เปิดแบบ LIFF เหมือนผูก 365\n\n" +
        "กดบันทึก/ยกเลิก → ปิดกลับแชทอัตโนมัติ\n\n" +
        "(อย่าใช้ลิงก์ tunnel เก่า)",
    },
    {
      type: "template",
      altText: "เปิดหน้าทดสอบตั้งค่าบนเว็บ",
      template: {
        type: "buttons",
        text: "หน้าทดสอบ — เลือกหัวข้อข่าวบนเว็บ\nกดบันทึกหรือยกเลิกแล้วปิดกลับแชท",
        actions: [{ type: "uri", label: "เปิดหน้าทดสอบ", uri: testUrl }],
      },
    },
  ]);

  console.log("Pushed setup test link to ake");
  console.log(testUrl);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
