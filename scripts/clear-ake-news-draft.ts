/** Clear stale news onboarding draft for ake. */
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
  const { clearNewsDraft } = await import("../lib/newsPrefs");
  const { pushLineMessages } = await import("../lib/line");
  const upn = "weerasak.pi@ktisgroup.com";
  await clearNewsDraft(upn);
  await pushLineMessages("U1faefe8ddeaec9f6aba2645f604b0dc6", [
    {
      type: "text",
      text:
        "🔧 แก้บั๊กแล้วครับ\n\n" +
        "เมื่อกี้ข้อความ “แนบรูปนัด…” ถูกเข้าโหมดตั้งค่าข่าว (wizard เก่าค้างอยู่) เลยถูกอ่านเป็นหัวข้อข่าว\n\n" +
        "ลองส่งอีกครั้งได้เลยครับ:\n" +
        "แนบรูป ส่งนัด เบส วันนี้ 15:00 เรื่อง testmeeting",
    },
  ]);
  console.log("Cleared draft for", upn);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
