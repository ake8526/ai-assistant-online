// ============================================================================
//  Public API — import this to plug the brief into another Node system.
//
//    import {
//      buildBrief, hostImage, toLineMessages,
//      getDedupRecent, saveDedup, publishLatest,
//    } from "tech-brief-agent";
//
//  Typical wiring into an EXISTING LINE sender:
//
//    const recent = await getDedupRecent();               // optional
//    const brief  = await buildBrief({ recent });
//    const url    = brief.image ? await hostImage(brief.image.buffer, brief.image.filename)
//                               : null;                    // or use YOUR own hosting
//    const messages = toLineMessages({ quietDay: brief.quietDay, imageUrl: url });
//    await yourLineClient.pushMessage({ to: YOUR_TARGET, messages });   // ← their sender
//    if (!brief.quietDay) await saveDedup(brief.stories); // optional
// ============================================================================

export { buildBrief } from "./brief.js";
export { hostImage, publishLatest } from "./storage.js";
export { getDedupRecent, saveDedup, fingerprint } from "./dedup.js";
export { toLineMessages, quietDayText } from "./deliver.js";
export { runAgent } from "./agent.js";
export { renderPng } from "./render.js";
export { CONFIG } from "./config.js";
export { getProvider, selectProviderName } from "./providers/index.js";
export {
  WHITELIST,
  CATEGORIES,
  ALL_SOURCES,
  WHITELIST_DOMAINS,
  matchSource,
} from "../config/sources.js";
