/** Push Morning Brief preview (LIFF) to ake. */
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

  const liffId = process.env.NEXT_PUBLIC_LIFF_ID || "2010856732-BFseuR2p";
  // Use ?next= static HTML — works on prod without React deploy (same pattern as setup-test.html).
  const url = `https://liff.line.me/${liffId}?next=${encodeURIComponent("/setup-brief.html")}`;
  const lineUserId = "U1faefe8ddeaec9f6aba2645f604b0dc6";

  await pushLineMessages(lineUserId, [
    {
      type: "text",
      text:
        "☀️ ตัวอย่าง Morning Brief (หน้าเว็บ)\n\n" +
        "• เปิด/ปิด · เวลาส่ง · วัน\n" +
        "• ลิงก์อนุญาตปฏิทิน\n" +
        "• ตัวอย่างข้อความใน LINE\n\n" +
        "🧪 ยังไม่บันทึกจริง — ดู UI ก่อน\n" +
        "กดบันทึก/ยกเลิก → ปิดกลับแชท",
    },
    {
      type: "template",
      altText: "เปิดตัวอย่าง Morning Brief",
      template: {
        type: "buttons",
        text: "ตัวอย่าง Morning Brief — สรุปตารางเช้าเข้า LINE",
        actions: [{ type: "uri", label: "เปิดตัวอย่าง", uri: url }],
      },
    },
  ]);

  console.log("Pushed Morning Brief preview to ake");
  console.log(url);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
