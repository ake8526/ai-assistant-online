import Anthropic from "@anthropic-ai/sdk";

const textOf = (resp) =>
  resp.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");

// The web_search tool `type` is date-versioned and CAN change — verify at docs.claude.com
export function makeAnthropic({ key, model, maxSearches, maxTokens }) {
  const client = new Anthropic({ apiKey: key });
  const MODEL = model || process.env.CLAUDE_MODEL || "claude-sonnet-5";
  const WS = { type: "web_search_20250305", name: "web_search", max_uses: maxSearches };

  async function createResuming(params) {
    let messages = params.messages;
    for (let i = 0; i < 5; i++) {
      const r = await client.messages.create({ ...params, messages });
      if (r.stop_reason === "pause_turn") { messages = [...messages, { role: "assistant", content: r.content }]; continue; }
      return r;
    }
    throw new Error("web_search did not finish");
  }

  return {
    async research(system, user) {
      const r = await createResuming({
        model: MODEL, max_tokens: 6000, system, tools: [WS],
        messages: [{ role: "user", content: user }],
      });
      return textOf(r);
    },
    async format(system, user) {
      const r = await client.messages.create({
        model: MODEL, max_tokens: maxTokens, system,
        messages: [{ role: "user", content: user }],
      });
      return textOf(r);
    },
  };
}
