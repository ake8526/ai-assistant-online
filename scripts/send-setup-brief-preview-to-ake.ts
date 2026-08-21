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
  const url = `https://liff.line.me/${liffId}?view=setup-brief`;
  const lineUserId = "U1faefe8ddeaec9f6aba2645f604b0dc6";

  await pushLineMessages(lineUserId, [
    {
      type: "text",
      text:
        "☀️ Morning Brief — ตั้งค่าเริ่มต้น (บันทึกจริง)\n\n" +
        "• เปิด/ปิด · เวลา · วัน\n" +
        "• กดบันทึกชั่วคราวหรือเสร็จสิ้น → ระบบจะปิดกลับแชทอัตโนมัติ",
    },
    {
      type: "template",
      altText: "เปิดตัวอย่าง Morning Brief",
      template: {
        type: "buttons",
        text: "ตั้งค่า Morning Brief — สรุปตารางเช้าเข้า LINE",
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
