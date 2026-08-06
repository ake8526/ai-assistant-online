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
  await pushLineMessages("U1faefe8ddeaec9f6aba2645f604b0dc6", [
    {
      type: "text",
      text:
        "📌 ทำไมเมื่อกี้ error\n\n" +
        "• onboarding ผ่านแล้ว ✓\n" +
        "• แต่ prod ยังเป็นโค้ดเก่า (deploy เต็มวันนี้)\n" +
        "• “แนบรูปนัดเบส” ไม่มีช่องว่าง → ระบบไม่รู้จัก → ไปเรียก AI → 429\n\n" +
        "ลองแบบนี้ (มีช่องว่าง + ส่งนัด):\n" +
        "แนบรูป ส่งนัด เบส วันนี้ 15:00 เรื่อง testmeeting",
    },
  ]);
  console.log("ok");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
