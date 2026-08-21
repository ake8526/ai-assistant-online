import fs from "node:fs/promises";
import { CONFIG, assertAgent, assertLine } from "./config.js";
import { buildBrief } from "./brief.js";
import { hostImage, publishLatest } from "./storage.js";
import { getDedupRecent, saveDedup } from "./dedup.js";
import { toLineMessages, quietDayText } from "./deliver.js";
import { makeLine } from "./line.js";

const supabaseReady = () => Boolean(CONFIG.supabase.url && CONFIG.supabase.serviceKey);

async function main() {
  assertAgent();
  if (CONFIG.run.sendLine && !CONFIG.dryRun) assertLine();
  const line = CONFIG.run.sendLine && !CONFIG.dryRun ? makeLine() : null;

  try {
    // dedup needs Supabase; skip gracefully if not configured
    const recent = supabaseReady() && !CONFIG.dryRun ? await getDedupRecent() : [];
    console.log(`↺ ${recent.length} recent stories in window`);

    const brief = await buildBrief({ recent });
    console.log(`⚙ provider = ${brief.provider}`);
    console.log(brief.quietDay ? "• quiet day" : `✓ ${brief.stories.length} stories`);

    // ---- quiet day ----
    if (brief.quietDay) {
      if (CONFIG.dryRun) return console.log("[dry-run] quiet day");
      if (line) await line.send(toLineMessages({ quietDay: true }));
      return;
    }

    // ---- dry-run: dump artifacts, no network ----
    if (CONFIG.dryRun) {
      await fs.writeFile("sample.png", brief.image.buffer);
      await fs.writeFile("sample.json", JSON.stringify(brief.stories, null, 2));
      return console.log("[dry-run] wrote sample.png + sample.json");
    }

    // ---- host the image (for a public URL) ----
    let imageUrl = null;
    if (CONFIG.run.hostImage || CONFIG.run.sendLine || CONFIG.run.publishLatest) {
      imageUrl = await hostImage(brief.image.buffer, brief.image.filename);
      console.log(`✓ hosted: ${imageUrl}`);
    }

    // ---- push via THIS project's LINE (optional) ----
    if (line) {
      await line.send(toLineMessages({ quietDay: false, imageUrl }));
      console.log(`✓ sent to LINE (${CONFIG.line.sendMode})`);
    }

    // ---- publish latest row for other systems (optional) ----
    if (CONFIG.run.publishLatest) {
      await publishLatest({ imageUrl, stories: brief.stories });
      console.log("✓ published latest row");
    }

    // ---- record dedup ----
    if (supabaseReady()) {
      await saveDedup(brief.stories);
      console.log("✓ dedup saved");
    }
    console.log("done");
  } catch (err) {
    console.error("✗ RUN FAILED:", err);
    try {
      if (line && CONFIG.line.ownerId) {
        await line.pushText(
          CONFIG.line.ownerId,
          `⚠️ Tech Brief ล้มเหลว\n${String(err?.message || err).slice(0, 400)}`
        );
      }
    } catch (e2) {
      console.error("  (failure alert also failed)", e2?.message || e2);
    }
    process.exit(1);
  }
}

main();
