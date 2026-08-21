// ---------------------------------------------------------------------------
// EXAMPLE: plug the brief into a Node system that ALREADY sends LINE.
// Run standalone with:  node integration/use-as-module.mjs   (needs .env)
// Or copy this shape into your senior's codebase.
// ---------------------------------------------------------------------------
import {
  buildBrief,
  hostImage,
  toLineMessages,
  getDedupRecent,
  saveDedup,
} from "../src/api.js";

// 👉 Replace this with your senior's existing LINE client / send function.
// It just has to accept ({ to, messages }). Example using @line/bot-sdk:
//
//   import { messagingApi } from "@line/bot-sdk";
//   const existingLineClient = new messagingApi.MessagingApiClient({
//     channelAccessToken: process.env.THEIR_LINE_TOKEN,
//   });
//
const existingLineClient = {
  async pushMessage({ to, messages }) {
    console.log("[would send to", to, "]", JSON.stringify(messages, null, 2));
  },
};
const TARGET = process.env.LINE_TARGET_ID || "REPLACE_WITH_THEIR_GROUP_ID";

async function runDailyBrief() {
  // 1) generate (agent + render). Pass recent so it won't repeat past stories.
  const recent = await getDedupRecent().catch(() => []); // dedup optional
  const brief = await buildBrief({ recent });

  // 2) get an image URL.
  //    Option A: use this project's Supabase hosting:
  const imageUrl = brief.image
    ? await hostImage(brief.image.buffer, brief.image.filename)
    : null;
  //    Option B: use YOUR OWN hosting instead — you have the raw bytes:
  //      const imageUrl = await yourUploader(brief.image.buffer);  // Buffer

  // 3) hand a ready LINE payload to the existing sender.
  const messages = toLineMessages({ quietDay: brief.quietDay, imageUrl });
  await existingLineClient.pushMessage({ to: TARGET, messages });

  // 4) remember what we sent (optional).
  if (!brief.quietDay) await saveDedup(brief.stories).catch(() => {});

  console.log(brief.quietDay ? "quiet day" : `sent ${brief.stories.length} stories`);
}

runDailyBrief().catch((e) => {
  console.error("brief failed:", e);
  process.exit(1);
});
