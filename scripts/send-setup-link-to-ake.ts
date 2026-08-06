/**
 * Push web setup page link to ake (simulate web onboarding).
 * Usage: npx tsx scripts/send-setup-link-to-ake.ts
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
  const { SETUP_URL } = await import("../lib/newsOnboarding");

  const lineUserId = "U1faefe8ddeaec9f6aba2645f604b0dc6";
  const upn = "weerasak.pi@ktisgroup.com";

  await pushLineMessages(lineUserId, [
    {
      type: "text",
      text:
        "สวัสดีครับ ake 👋\n\n" +
        "ทดลองตั้งค่าบนหน้าเว็บใหม่ครับ — สะดวกกว่าในแชท\n\n" +
        "① เลือกหัวข้อข่าว\n" +
        "② ตั้งเวลาแจ้ง\n" +
        "③ ผูก YouTube / RSS / ปฏิทิน\n" +
        "④ กด “เสร็จสิ้น” → สรุปจะกลับมาใน LINE อัตโนมัติ",
    },
    {
      type: "template",
      altText: "เปิดหน้าตั้งค่าบนเว็บ",
      template: {
        type: "buttons",
        text: "ตั้งค่าบนหน้าเว็บ — เลือกหัวข้อ เวลาแจ้ง ผูก YouTube/RSS และปฏิทินได้ในที่เดียว",
        actions: [{ type: "uri", label: "เปิดหน้าตั้งค่า", uri: SETUP_URL }],
      },
    },
  ]);

  console.log(`Pushed setup link to ake · ${upn}`);
  console.log(SETUP_URL);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
