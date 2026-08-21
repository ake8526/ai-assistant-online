/**
 * Push calendar consent page to Nont + ready-to-use notice.
 * Usage: npx tsx scripts/send-calendar-link-to-nont.ts
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

  const upn = "nanatpon.n@ktisgroup.com";
  const lineUserId = "Ucd8070c2f8b862a7a4ebf03ea3be9500";
  const accountUrl = `${(process.env.NEXT_PUBLIC_APP_BASE_URL || "https://ktis-ai-assistant.vercel.app").replace(/\/$/, "")}/account`;

  await pushLineMessages(lineUserId, [
    {
      type: "text",
      text:
        "สวัสดีครับ Nont 👋\n\n" +
        "ระบบ KTIS X AI Assistant พร้อมใช้งานแล้วครับ\n\n" +
        "กดปุ่มด้านล่างเพื่ออนุญาตปฏิทิน Microsoft 365 — จะได้ดูตาราง จองนัด และรับสรุปเช้าได้เหมือนใน Outlook\n\n" +
        "หลังอนุญาตแล้วลองพิมพ์ “ตารางวันนี้” ได้เลยครับ",
    },
    {
      type: "template",
      altText: "อนุญาตปฏิทิน Microsoft 365",
      template: {
        type: "buttons",
        text: "ผูกปฏิทิน Microsoft 365",
        actions: [{ type: "uri", label: "อนุญาตปฏิทิน", uri: accountUrl }],
      },
    },
  ]);

  console.log(`Pushed calendar link to Nont · ${upn} · ${lineUserId}`);
  console.log(accountUrl);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
