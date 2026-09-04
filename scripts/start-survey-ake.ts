/**
 * Push LINE chat survey intro to ake (pilot).
 * Usage: npx tsx scripts/start-survey-ake.ts
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
  const { pushSurveyInvite, isSurveyPilot } = await import("../lib/lineSurvey");
  const upn = "weerasak.pi@ktisgroup.com";
  if (!(await isSurveyPilot(upn))) {
    throw new Error("ake is not in survey pilot list");
  }
  await pushSurveyInvite(upn);
  console.log("Pushed LINE survey intro to ake ·", upn);
  console.log('In LINE: tap "เริ่มสำรวจ" or type เริ่มสำรวจ');
  console.log("Cancel: ยกเลิกแบบสำรวจ");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
