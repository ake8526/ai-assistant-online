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
        "⚠️ เมื่อกี้ error เพราะเวลา 15.00 (จุด)\n" +
        "prod รองรับแค่ 15:00 (โคลอน) ตอนนี้\n\n" +
        "✅ คัดลอกส่งบรรทัดนี้:\n\n" +
        "แนบรูป ส่งนัด เบส วันนี้ 15:00 เรื่อง testmeeting\n\n" +
        "(รูปที่ส่งไว้แล้วยังอยู่ ไม่ต้องส่งใหม่)",
    },
  ]);
  console.log("ok");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
