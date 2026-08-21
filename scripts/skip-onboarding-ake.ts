/** Skip news onboarding gate so booking works (prod may lag deploy). */
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
  const { clearNewsDraft, setNewsOnboardingDone } = await import("../lib/newsPrefs");
  const { pushLineMessages } = await import("../lib/line");
  const { SETUP_URL } = await import("../lib/newsOnboarding");

  const upn = "weerasak.pi@ktisgroup.com";
  const lineUserId = "U1faefe8ddeaec9f6aba2645f604b0dc6";

  await clearNewsDraft(upn);
  await setNewsOnboardingDone(upn, true);

  await pushLineMessages(lineUserId, [
    {
      type: "text",
      text:
        "⚡ ข้าม onboarding ชั่วคราวแล้วครับ — จองนัด/แนบรูปใช้ได้เลย\n\n" +
        "ลองอีกครั้ง:\n" +
        "แนบรูป ส่งนัด เบส วันนี้ 15:00 เรื่อง testmeeting\n\n" +
        `ตั้งค่าข่าวทีหลัง: ${SETUP_URL}`,
    },
  ]);
  console.log("onboarding skipped for", upn);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
