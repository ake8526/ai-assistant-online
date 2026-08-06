import fs from "fs";
import path from "path";
import { getEvent } from "../lib/graph";
import { getTranscriptText, summarize, formatSummary } from "../lib/meetings";

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
  const upn = process.argv[2] || "weerasak.pi@ktisgroup.com";
  const eventId =
    process.argv[3] ||
    "AAMkAGFkNzRlMzhiLTk4N2UtNGQyMS05Mzc1LWQ4OGQ2NzE5NTRjYQBGAAAAAABa0SIcABUQT65JOKJQm1A1BwDro5hO4wzzSona6Mlya1OVAAAAAAENAADro5hO4wzzSona6Mlya1OVAAA6zvD7AAA=";

  const ev = await getEvent(upn, eventId);
  if (!ev) throw new Error("event not found");
  console.log("subject:", ev.subject);
  const text = await getTranscriptText(upn, ev);
  console.log("transcript chars:", text?.length ?? 0);
  if (!text) throw new Error("no transcript");
  const result = await summarize(text, ev.subject || "meeting");
  console.log("\n" + formatSummary(ev.subject || "meeting", result));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
