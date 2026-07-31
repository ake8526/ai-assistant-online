// Pluggable LLM client with provider fallback.
// LLM_PROVIDER supports a comma-separated chain, e.g. "qwen,groq"
// (try first, fall back on failure). Always replies in Thai (primary) / English only.

const LANGUAGE_RULE =
  "\n\nกติกาภาษา: ตอบเป็นภาษาไทยเป็นหลักเสมอ ใช้อังกฤษเฉพาะศัพท์เทคนิค/ชื่อเฉพาะ ห้ามตอบภาษาอื่นเด็ดขาด";

type Provider = "qwen" | "groq";

function providerChain(fast = false): Provider[] {
  const raw = (process.env.LLM_PROVIDER || "qwen,groq").toLowerCase();
  const wanted = raw.split(",").map((s) => s.trim()).filter(Boolean) as Provider[];
  const known: Provider[] = ["qwen", "groq"];
  let chain = wanted.filter((p) => known.includes(p));
  if (!chain.length) chain = fast ? ["groq", "qwen"] : ["qwen", "groq"];
  // Latency-sensitive calls (e.g. intent parsing on every LINE message) prefer
  // groq: it classifies in ~0.5s vs ~5s for qwen. Quality-sensitive generation
  // keeps the configured order.
  if (fast && chain.includes("groq")) chain = ["groq", ...chain.filter((p) => p !== "groq")];
  return chain;
}

function settings(provider: Provider): { baseUrl: string; key: string; model: string } | null {
  if (provider === "qwen") {
    const key = process.env.QWEN_API_KEY || process.env.DASHSCOPE_API_KEY || "";
    if (!key) return null;
    return {
      baseUrl: process.env.QWEN_BASE_URL || "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
      key,
      model: process.env.QWEN_MODEL || "qwen3.7-plus",
    };
  }
  const key = process.env.GROQ_API_KEY || "";
  if (!key) return null;
  return {
    baseUrl: "https://api.groq.com/openai/v1",
    key,
    model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
  };
}

async function callProvider(
  provider: Provider,
  system: string,
  user: string,
  opts?: { json?: boolean; temperature?: number; timeoutMs?: number }
): Promise<string> {
  const cfg = settings(provider);
  if (!cfg) throw new Error(`${provider} not configured`);

  // Hard timeout so a slow/hanging provider aborts and falls back instead of
  // blocking the whole request (LINE users were waiting ~5s+ on qwen).
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? 20000);
  let res: Response;
  try {
    res = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.key}`, "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: cfg.model,
        temperature: opts?.temperature ?? 0.3,
        ...(opts?.json ? { response_format: { type: "json_object" } } : {}),
        messages: [
          { role: "system", content: system + (opts?.json ? "" : LANGUAGE_RULE) },
          { role: "user", content: user },
        ],
      }),
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`${provider} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return (data.choices?.[0]?.message?.content ?? "").trim();
}

export async function chat(
  system: string,
  user: string,
  opts?: { json?: boolean; temperature?: number; fast?: boolean; timeoutMs?: number }
): Promise<string> {
  const chain = providerChain(opts?.fast).filter((p) => settings(p));
  if (!chain.length) throw new Error("No LLM provider configured (set QWEN_API_KEY and/or GROQ_API_KEY)");

  const errors: string[] = [];
  for (let i = 0; i < chain.length; i++) {
    const provider = chain[i];
    try {
      return await callProvider(provider, system, user, opts);
    } catch (e) {
      errors.push(`${provider}: ${String(e).slice(0, 180)}`);
      if (i + 1 < chain.length) {
        console.warn(`[llm] ${provider} failed; trying ${chain[i + 1]} next`);
      }
    }
  }
  throw new Error(`All LLM providers failed — ${errors.join(" | ")}`);
}
