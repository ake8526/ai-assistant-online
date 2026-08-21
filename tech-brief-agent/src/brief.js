import { runAgent } from "./agent.js";
import { renderPng } from "./render.js";
import { CONFIG } from "./config.js";

const ymd = (d) =>
  new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: CONFIG.brief.tzLabel,
  }).format(d);

/**
 * Generate today's brief. PURE — no LINE, no upload. The caller decides how to
 * deliver. Pass `recent` (from getDedupRecent) so it won't repeat past stories.
 *
 * returns {
 *   quietDay: boolean,           // true = no qualifying stories today
 *   date: Date,
 *   stories: Story[],            // [] when quietDay
 *   image: { buffer, filename, contentType } | null   // null when quietDay
 * }
 */
export async function buildBrief({ recent = [] } = {}) {
  const date = new Date();
  const { stories, provider } = await runAgent({ recent });

  if (stories.length === 0) {
    return { quietDay: true, date, stories: [], image: null, provider };
  }

  const buffer = await renderPng(stories, {
    date,
    count: stories.length,
    tz: CONFIG.brief.tzLabel,
  });

  return {
    quietDay: false,
    date,
    stories,
    provider,
    image: { buffer, filename: `brief-${ymd(date)}.png`, contentType: "image/png" },
  };
}
