import fs from "fs";
import path from "path";

function loadEnvLocal() {
  const p = path.join(process.cwd(), ".env.local");
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    if (!process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

async function main() {
  loadEnvLocal();
  const { getEvent } = await import("../lib/graph");
  const { getTranscriptText, summarize, formatSummary } = await import("../lib/meetings");
  const { sendLine } = await import("../lib/line");

  const upn = "weerasak.pi@ktisgroup.com"; // display_name: ake
  const eventId =
    "AAMkAGFkNzRlMzhiLTk4N2UtNGQyMS05Mzc1LWQ4OGQ2NzE5NTRjYQBGAAAAAABa0SIcABUQT65JOKJQm1A1BwDro5hO4wzzSona6Mlya1OVAAAAAAENAADro5hO4wzzSona6Mlya1OVAAA6zvD7AAA=";

  const ev = await getEvent(upn, eventId);
  if (!ev) throw new Error("event not found");
  const text = await getTranscriptText(upn, ev);
  if (!text) throw new Error("no transcript");
  const result = await summarize(text, ev.subject || "meeting");
  const message = formatSummary(ev.subject || "meeting", result);
  console.log(message.slice(0, 500) + "…\n");
  await sendLine(upn, "", message);
  console.log("sent to ake (" + upn + ")");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
