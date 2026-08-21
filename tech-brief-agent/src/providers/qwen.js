// Alibaba Qwen via DashScope (OpenAI-compatible). Research sets enable_search
// so Qwen browses the web. Verify base URL / model names / search flag at
// https://www.alibabacloud.com/help/en/model-studio/
export function makeQwen({ key, model, searchModel }) {
  // international endpoint; use dashscope.aliyuncs.com (CN) if your key is CN.
  const URL = (process.env.QWEN_BASE_URL || "https://dashscope-intl.aliyuncs.com/compatible-mode/v1") + "/chat/completions";
  const H = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  const MODEL = model || "qwen-plus";
  const SEARCH_MODEL = searchModel || MODEL;

  async function chat(m, system, user, search) {
    const body = { model: m, messages: [{ role: "system", content: system }, { role: "user", content: user }] };
    if (search) body.enable_search = true; // DashScope web search
    const res = await fetch(URL, { method: "POST", headers: H, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`Qwen ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const d = await res.json();
    return d.choices?.[0]?.message?.content || "";
  }

  return {
    async research(system, user) { return chat(SEARCH_MODEL, system, user, true); },
    async format(system, user) { return chat(MODEL, system, user, false); },
  };
}
