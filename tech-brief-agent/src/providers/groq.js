// Groq (OpenAI-compatible endpoint). Research uses a web-search-capable
// compound model; format uses a fast open model. Verify current model names at
// https://console.groq.com/docs
export function makeGroq({ key, model, searchModel }) {
  const URL = "https://api.groq.com/openai/v1/chat/completions";
  const H = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  const CHAT_MODEL = model || "openai/gpt-oss-120b"; // llama-3.3-70b-versatile ปลดระวาง 2026-08-16
  const SEARCH_MODEL = searchModel || "groq/compound"; // built-in web search

  async function chat(m, system, user) {
    const res = await fetch(URL, {
      method: "POST", headers: H,
      body: JSON.stringify({ model: m, messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
    });
    if (!res.ok) throw new Error(`Groq ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const d = await res.json();
    return d.choices?.[0]?.message?.content || "";
  }

  return {
    async research(system, user) { return chat(SEARCH_MODEL, system, user); },
    async format(system, user) { return chat(CHAT_MODEL, system, user); },
  };
}
