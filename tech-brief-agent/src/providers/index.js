import { CONFIG, PROVIDER_KEYS } from "../config.js";
import { makeAnthropic } from "./anthropic.js";
import { makeOpenAI } from "./openai.js";
import { makeGemini } from "./gemini.js";
import { makeGroq } from "./groq.js";
import { makeQwen } from "./qwen.js";

const FACTORIES = { anthropic: makeAnthropic, openai: makeOpenAI, gemini: makeGemini, groq: makeGroq, qwen: makeQwen };
const ORDER = Object.keys(PROVIDER_KEYS); // auto-select priority

// Which provider will be used, given env (AI_PROVIDER override → else first key present).
export function selectProviderName() {
  const want = CONFIG.aiProvider;
  if (want) {
    if (!FACTORIES[want]) throw new Error(`Unknown AI_PROVIDER "${want}". Use: ${ORDER.join(", ")}`);
    if (!process.env[PROVIDER_KEYS[want]]) throw new Error(`AI_PROVIDER=${want} but ${PROVIDER_KEYS[want]} is not set`);
    return want;
  }
  const found = ORDER.find((name) => process.env[PROVIDER_KEYS[name]]);
  if (!found) throw new Error("No AI provider key set. Add one of: " + Object.values(PROVIDER_KEYS).join(", "));
  return found;
}

// Build the active provider. Each exposes: name, research(system,user), format(system,user)
export function getProvider() {
  const name = selectProviderName();
  const opts = {
    key: process.env[PROVIDER_KEYS[name]],
    model: process.env[`MODEL_${name.toUpperCase()}`],             // optional override
    searchModel: process.env[`SEARCH_MODEL_${name.toUpperCase()}`],// optional override
    maxSearches: CONFIG.maxSearches,
    maxTokens: CONFIG.maxTokens,
  };
  const provider = FACTORIES[name](opts);
  provider.name = name;
  return provider;
}
