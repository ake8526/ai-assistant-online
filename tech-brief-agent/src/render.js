import puppeteer from "puppeteer";
import { buildHtml } from "./template.js";

// Renders the infographic to a PNG Buffer. Screenshots the #card element
// (not a fixed viewport) so the image height grows with the number of stories.
export async function renderPng(stories, meta = {}) {
  const html = buildHtml(stories, meta);

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--font-render-hinting=none",
      "--force-color-profile=srgb",
    ],
    // GitHub Actions / your machine: let Puppeteer use its downloaded Chrome,
    // or set PUPPETEER_EXECUTABLE_PATH to a system Chromium.
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
  });

  try {
    const page = await browser.newPage();
    // deviceScaleFactor 2 => crisp @2x output (~2160px wide source).
    await page.setViewport({ width: 1080, height: 1200, deviceScaleFactor: 2 });
    await page.setContent(html, { waitUntil: "networkidle0", timeout: 60_000 });

    // Make sure Kanit is actually loaded before the shot.
    await page.evaluate(async () => {
      if (document.fonts && document.fonts.ready) await document.fonts.ready;
    });

    const card = await page.$("#card");
    if (!card) throw new Error("#card element not found in template");
    const buf = await card.screenshot({ type: "png" });
    return buf;
  } finally {
    await browser.close();
  }
}
