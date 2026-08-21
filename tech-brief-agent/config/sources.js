// ---------------------------------------------------------------------------
// WHITELIST — the credibility gate.
// The agent searches the WHOLE open web, but a story is only ever published if
// its source URL belongs to one of these domains. Edit freely.
// (index.js re-checks every story's domain against this list as a safety net,
//  so the whitelist here is the single source of truth.)
// ---------------------------------------------------------------------------

export const WHITELIST = {
  global: [
    { name: "TechCrunch",            domain: "techcrunch.com" },
    { name: "The Verge",             domain: "theverge.com" },
    { name: "Ars Technica",          domain: "arstechnica.com" },
    { name: "Wired",                 domain: "wired.com" },
    { name: "Engadget",              domain: "engadget.com" },
    { name: "Reuters",               domain: "reuters.com" },
    { name: "Bloomberg",             domain: "bloomberg.com" },
    { name: "The Information",       domain: "theinformation.com" },
    { name: "MIT Technology Review", domain: "technologyreview.com" },
    { name: "VentureBeat",           domain: "venturebeat.com" },
    // Official / primary sources
    { name: "OpenAI",                domain: "openai.com" },
    { name: "Google",                domain: "blog.google" },
    { name: "Google DeepMind",       domain: "deepmind.google" },
    { name: "Anthropic",             domain: "anthropic.com" },
    { name: "Meta AI",               domain: "ai.meta.com" },
    { name: "Microsoft",             domain: "blogs.microsoft.com" },
    { name: "arXiv",                 domain: "arxiv.org" },
  ],
  thai: [
    { name: "Blognone",              domain: "blognone.com" },
    { name: "Beartai",               domain: "beartai.com" },
    { name: "Techsauce",             domain: "techsauce.co" },
    { name: "Thumbsup",              domain: "thumbsup.in.th" },
    { name: "Droidsans",             domain: "droidsans.com" },
  ],
};

// Story categories shown as red chips on the infographic.
export const CATEGORIES = ["AI", "Startup", "Funding", "Policy", "Gadget"];

export const ALL_SOURCES = [...WHITELIST.global, ...WHITELIST.thai];
export const WHITELIST_DOMAINS = ALL_SOURCES.map((s) => s.domain);

// Given a URL, return the matching whitelisted source (or null).
export function matchSource(url) {
  if (!url) return null;
  let host;
  try {
    host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
  return (
    ALL_SOURCES.find((s) => host === s.domain || host.endsWith("." + s.domain)) ||
    null
  );
}
