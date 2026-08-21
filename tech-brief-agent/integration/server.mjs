// ---------------------------------------------------------------------------
// OPTIONAL: HTTP endpoint for a NON-Node sender (PHP/Python/n8n/etc.).
// Start:  node integration/server.mjs      (listens on PORT, default 8787)
//
//   GET /brief          -> generates today's brief, returns JSON:
//                          { quietDay, imageUrl, stories, lineMessages }
//   GET /health         -> { ok: true }
//
// Your existing system calls GET /brief on a schedule and pushes `imageUrl`
// (or `lineMessages`) through its own LINE integration.
//
// Protect it: set BRIEF_TOKEN and pass ?token=... (basic guard).
// ---------------------------------------------------------------------------
import http from "node:http";
import {
  buildBrief,
  hostImage,
  toLineMessages,
  getDedupRecent,
  saveDedup,
} from "../src/api.js";

const PORT = parseInt(process.env.PORT || "8787", 10);
const TOKEN = process.env.BRIEF_TOKEN || null;

async function handleBrief() {
  const recent = await getDedupRecent().catch(() => []);
  const brief = await buildBrief({ recent });
  const imageUrl = brief.image
    ? await hostImage(brief.image.buffer, brief.image.filename)
    : null;
  if (!brief.quietDay) await saveDedup(brief.stories).catch(() => {});
  return {
    quietDay: brief.quietDay,
    provider: brief.provider,
    imageUrl,
    stories: brief.stories,
    lineMessages: toLineMessages({ quietDay: brief.quietDay, imageUrl }),
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  // CORS so a file:// pixel-monitor page can read /brief
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  const json = (code, body) => {
    res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  };
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  if (url.pathname === "/health") return json(200, { ok: true });

  if (url.pathname === "/brief") {
    if (TOKEN && url.searchParams.get("token") !== TOKEN)
      return json(401, { error: "unauthorized" });
    try {
      return json(200, await handleBrief());
    } catch (e) {
      console.error("brief failed:", e);
      return json(500, { error: String(e?.message || e) });
    }
  }

  json(404, { error: "not found" });
});

server.listen(PORT, () => console.log(`brief server on :${PORT}`));
