import { messagingApi } from "@line/bot-sdk";
import { CONFIG } from "./config.js";

// LINE Official Account transport. Supports:
//   broadcast  -> to ALL followers of the OA (LINE OA)   [default]
//   push       -> to a specific user/group/room id
export function makeLine() {
  const client = new messagingApi.MessagingApiClient({ channelAccessToken: CONFIG.line.token });
  return {
    async broadcast(messages) {
      await client.broadcast({ messages });
    },
    async pushMessages(to, messages) {
      await client.pushMessage({ to, messages });
    },
    // send by the configured mode (broadcast to OA followers, or push to target)
    async send(messages) {
      if (CONFIG.line.sendMode === "push") {
        await client.pushMessage({ to: CONFIG.line.targetId, messages });
      } else {
        await client.broadcast({ messages });
      }
    },
    async pushText(to, text) {
      await client.pushMessage({ to, messages: [{ type: "text", text }] });
    },
  };
}
