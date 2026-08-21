// OpenAI (chat completions). Research uses a web-search-enabled model
// (e.g. gpt-4o-search-preview). Verify current search model/params at
// https://platform.openai.com/docs
export function makeOpenAI({ key, model, searchModel }) {
  const URL = "https://api.openai.com/v1/chat/completions";
  const H = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  const CHAT_MODEL = model || "gpt-4o-mini";
  const SEARCH_MODEL = searchModel || "gpt-4o-search-preview";

  async function chat(m, system, user, extra = {}) {
    const res = await fetch(URL, {
      method: "POST", headers: H,
      body: JSON.stringify({ model: m, messages: [{ role: "system", content: system }, { role: "user", content: user }], ...extra }),
    });
    if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const d = await res.json();
    return d.choices?.[0]?.message?.content || "";
  }

  return {
    async research(system, user) {
      // search-preview models browse the web automatically
      return chat(SEARCH_MODEL, system, user, { web_search_options: {} });
    },
    async format(system, user) {
      return chat(CHAT_MODEL, system, user, { temperature: 0.2 });
    },
  };
}
