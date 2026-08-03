// LINE news onboarding + later “ตั้งค่าข่าว” manage menu.
import { clampNewsCount, saveNotifyKind } from "@/lib/notify";
import {
  NEWS_TOPIC_PRESETS,
  clearNewsDraft,
  getNewsPrefs,
  loadNewsDraft,
  presetById,
  saveNewsDraft,
  setNewsInterested,
  setNewsOnboardingDone,
  setNewsTopics,
} from "@/lib/newsPrefs";
import { listManagedFeeds } from "@/lib/feeds";
import { getLineId, pushLineMessages, replyLine, replyLineMessages } from "@/lib/line";
import { admin } from "@/lib/supabaseServer";

const APP_BASE = (process.env.NEXT_PUBLIC_APP_BASE_URL || "https://ktis-ai-assistant.vercel.app").replace(/\/$/, "");
const SETTINGS_URL = `${APP_BASE}/consents`;

async function getYouTubeFollowStatus(upn: string): Promise<{
  linked: boolean;
  email: string | null;
  channel: string | null;
  granted: boolean;
}> {
  const [{ data: tok }, { data: cons }] = await Promise.all([
    admin
      .from("oauth_tokens")
      .select("refresh_token, account_email, account_name, account_channel")
      .eq("owner_upn", upn)
      .eq("provider", "google")
      .maybeSingle(),
    admin
      .from("consents")
      .select("granted")
      .eq("owner_upn", upn)
      .eq("capability", "src_youtube")
      .maybeSingle(),
  ]);
  const linked = !!tok?.refresh_token;
  return {
    linked,
    email: (tok as { account_email?: string } | null)?.account_email || null,
    channel: (tok as { account_channel?: string } | null)?.account_channel || null,
    granted: cons?.granted !== false && linked, // default on when linked
  };
}

function qr(items: { label: string; data?: string; uri?: string; displayText?: string }[]) {
  return {
    items: items.slice(0, 13).map((it) => {
      if (it.uri) {
        return {
          type: "action",
          action: { type: "uri", label: it.label.slice(0, 20), uri: it.uri },
        };
      }
      return {
        type: "action",
        action: {
          type: "postback",
          label: it.label.slice(0, 20),
          data: it.data || "",
          displayText: (it.displayText || it.label).slice(0, 60),
        },
      };
    }),
  };
}

async function send(via: "push" | "reply", upn: string, messages: object[], replyToken?: string) {
  if (via === "reply" && replyToken) {
    await replyLineMessages(replyToken, messages);
    return;
  }
  const lineId = await getLineId(upn);
  if (!lineId) throw new Error("ยังไม่ได้เชื่อม LINE");
  await pushLineMessages(lineId, messages);
}

export function askInterestedMessage(): object {
  return {
    type: "text",
    text:
      "ยินดีต้อนรับครับ 👋\n\n" +
      "ก่อนเริ่มใช้งาน ขอถามสั้น ๆ:\n" +
      "คุณต้องการให้ช่วยติดตามและสรุปข่าวสารเข้า LINE ไหมครับ?",
    quickReply: qr([
      { label: "✅ ใช่ อยากติดตาม", data: "a=newsyes", displayText: "ใช่ อยากติดตามข่าว" },
      { label: "❌ ไม่เอาตอนนี้", data: "a=newsno", displayText: "ไม่ติดตามข่าวตอนนี้" },
    ]),
  };
}

function topicsPrompt(selected: string[]): object {
  const n = selected.length;
  const picked = n
    ? `\n\n✅ เลือกแล้ว ${n} หัวข้อ:\n${selected.map((t, i) => `  ${i + 1}. ${t}`).join("\n")}`
    : "\n\nยังไม่ได้เลือก — กดปุ่มด้านล่างได้หลายอันเรื่อย ๆ";

  const remaining = NEWS_TOPIC_PRESETS.filter((p) => !selected.includes(p.label));
  const lines =
    remaining.length > 0
      ? remaining.map((p, i) => `${i + 1}) ${p.label}`).join("\n")
      : "(เลือกครบทุกหัวข้อแล้ว)";

  const actions: { label: string; data: string; displayText?: string }[] = [];
  if (n > 0) {
    actions.push({
      label: `✅ เสร็จแล้ว (${n})`,
      data: "a=newstopicsdone",
      displayText: "เลือกหัวข้อเสร็จแล้ว",
    });
  }
  for (const p of remaining) {
    actions.push({
      label: p.label.slice(0, 20),
      data: `a=newstopic&t=${p.id}`,
      displayText: `เพิ่ม ${p.label}`,
    });
  }
  actions.push({ label: "✏️ พิมพ์เอง", data: "a=newscustom", displayText: "พิมพ์หัวข้อเอง" });
  if (n === 0) {
    actions.push({ label: "✅ เสร็จแล้ว", data: "a=newstopicsdone", displayText: "เลือกหัวข้อเสร็จแล้ว" });
  }

  return {
    type: "text",
    text:
      "เลือกหัวข้อข่าวได้หลายอันครับ 👍\n" +
      "กดปุ่มทีละหัวข้อได้เรื่อย ๆ (หัวข้อที่เลือกแล้วจะหายจากปุ่ม)\n" +
      "หรือพิมพ์หัวข้อเอง เช่น “เซมิคอนดักเตอร์”\n\n" +
      (remaining.length ? `หัวข้อที่ยังเลือกได้:\n${lines}` : lines) +
      picked +
      (n > 0 ? "\n\nครบแล้วกด “เสร็จแล้ว” ได้เลย" : "\n\nเลือกอย่างน้อย 1 หัวข้อ แล้วกด “เสร็จแล้ว”"),
    quickReply: qr(actions),
  };
}

function countPrompt(): object {
  return {
    type: "text",
    text:
      "ต้องการให้อัปเดตข่าววันละกี่เรื่องครับ?\n\n" +
      "• ทั้งหมด = ทุกเรื่องที่เกี่ยวข้องวันนี้\n" +
      "• หรือเลือก 3 / 5 / 10 เรื่องต่อวัน",
    quickReply: qr([
      { label: "ทั้งหมด", data: "a=newscount&n=0", displayText: "อัปเดตทั้งหมด" },
      { label: "วันละ 3 เรื่อง", data: "a=newscount&n=3", displayText: "วันละ 3 เรื่อง" },
      { label: "วันละ 5 เรื่อง", data: "a=newscount&n=5", displayText: "วันละ 5 เรื่อง" },
      { label: "วันละ 10 เรื่อง", data: "a=newscount&n=10", displayText: "วันละ 10 เรื่อง" },
    ]),
  };
}

function countLabel(n: number): string {
  return n === 0 ? "ทั้งหมดที่เกี่ยวข้องวันนี้" : `วันละ ${n} เรื่อง`;
}

async function buildFollowListText(upn: string): Promise<string> {
  const prefs = await getNewsPrefs(upn);
  const [feeds, yt] = await Promise.all([
    listManagedFeeds(upn).catch(() => []),
    getYouTubeFollowStatus(upn).catch(() => ({
      linked: false,
      email: null,
      channel: null,
      granted: false,
    })),
  ]);
  const lines = ["📰 รายการที่คุณติดตามอยู่ตอนนี้", ""];

  if (!prefs.interested) {
    lines.push("สถานะสรุปหัวข้อข่าว: ปิดอัตโนมัติ");
  } else {
    lines.push(`สถานะสรุปหัวข้อข่าว: เปิด · อัปเดต ${countLabel(prefs.count)}`);
  }
  lines.push("");

  // YouTube subscriptions (OAuth — not a manual feed row)
  if (yt.linked) {
    const who = [yt.channel ? `ช่อง: ${yt.channel}` : null, yt.email].filter(Boolean).join(" · ");
    lines.push("YouTube:");
    lines.push(`  ✅ เชื่อมแล้ว${who ? ` (${who})` : ""}`);
    lines.push("     → ดึงคลิปใหม่จากช่องที่คุณกด Subscribe");
    if (!yt.granted) lines.push("     ⚠️ ยังไม่ได้เปิดสิทธิ์ src_youtube — ลองเชื่อมใหม่ที่หน้าตั้งค่า");
  } else {
    lines.push("YouTube: ยังไม่ได้เชื่อมบัญชี Google");
    lines.push(`  → เชื่อมได้ที่หน้าตั้งค่า: ${SETTINGS_URL}`);
  }
  lines.push("");

  if (prefs.topics.length) {
    lines.push("หัวข้อข่าว:");
    prefs.topics.forEach((t, i) => lines.push(`  ${i + 1}. ${t}`));
  } else {
    lines.push("หัวข้อข่าว: (ยังไม่มี)");
  }
  lines.push("");

  if (feeds.length) {
    lines.push("แหล่ง RSS / Facebook:");
    feeds.forEach((f, i) => {
      const kind = f.kind === "facebook" ? "FB" : "RSS";
      lines.push(`  ${i + 1}. [${kind}] ${(f.label || "").trim() || f.ref}`);
    });
  } else {
    lines.push("แหล่ง RSS / Facebook: (ยังไม่มี — เพิ่มได้ที่หน้าตั้งค่า)");
  }

  lines.push("");
  lines.push("ต้องการทำอะไรต่อครับ?");
  return lines.join("\n");
}

function manageMenuMessage(listText: string): object {
  return {
    type: "text",
    text: listText,
    quickReply: qr([
      { label: "➕ เพิ่มหัวข้อ", data: "a=newsadd", displayText: "เพิ่มหัวข้อข่าว" },
      { label: "🗑 ลบหัวข้อ", data: "a=newsdel", displayText: "ลบหัวข้อข่าว" },
      { label: "✏️ กำหนดเอง", data: "a=newscustom", displayText: "พิมพ์หัวข้อเอง" },
      { label: "🔢 จำนวนข่าว/วัน", data: "a=newseditcount", displayText: "เปลี่ยนจำนวนข่าวต่อวัน" },
      { label: "🌐 หน้าตั้งค่า", uri: SETTINGS_URL },
    ]),
  };
}

function deletePrompt(topics: string[]): object {
  if (!topics.length) {
    return {
      type: "text",
      text: "ยังไม่มีหัวข้อให้ลบครับ",
      quickReply: qr([{ label: "กลับเมนู", data: "a=newsmenu", displayText: "ตั้งค่าข่าว" }]),
    };
  }
  const lines = topics.map((t, i) => `${i + 1}) ${t}`).join("\n");
  return {
    type: "text",
    text: `เลือกหัวข้อที่ต้องการลบครับ\n\n${lines}`,
    quickReply: qr([
      ...topics.slice(0, 10).map((t, i) => ({
        label: `${i + 1}`,
        data: `a=newsdeli&i=${i + 1}`,
        displayText: `ลบ ${t}`,
      })),
      { label: "🔙 กลับ", data: "a=newsmenu", displayText: "กลับเมนูตั้งค่าข่าว" },
    ]),
  };
}

/** Manage menu for users who already finished onboarding. */
export async function openNewsSettings(upn: string, via: "push" | "reply", replyToken?: string): Promise<void> {
  const prefs = await getNewsPrefs(upn);
  await saveNewsDraft(upn, { step: "manage", topics: prefs.topics, ts: Date.now() });
  const listText = await buildFollowListText(upn);
  await send(via, upn, [manageMenuMessage(listText)], replyToken);
}

/** Start or resume first-time onboarding. */
export async function startNewsOnboarding(upn: string, via: "push" | "reply", replyToken?: string): Promise<void> {
  const prefs = await getNewsPrefs(upn);
  // Already set up → show manage menu instead of welcome again
  if (prefs.onboardingDone) {
    await openNewsSettings(upn, via, replyToken);
    return;
  }

  const existing = await loadNewsDraft(upn);
  let msg: object;
  if (existing?.step === "topics") {
    msg = topicsPrompt(existing.topics || []);
  } else if (existing?.step === "count") {
    msg = countPrompt();
  } else if (existing?.step === "delete" || existing?.step === "manage") {
    await openNewsSettings(upn, via, replyToken);
    return;
  } else {
    await saveNewsDraft(upn, { step: "ask", topics: existing?.topics || [], ts: Date.now() });
    await setNewsOnboardingDone(upn, false);
    msg = askInterestedMessage();
  }
  await send(via, upn, [msg], replyToken);
}

export async function handleNewsOnboardingText(
  upn: string,
  text: string,
  replyToken: string
): Promise<boolean> {
  const draft = await loadNewsDraft(upn);
  if (!draft) return false;

  if (draft.step === "topics" || draft.step === "manage") {
    // Only treat as custom topic when mid topics-pick, or manage after "กำหนดเอง"
    if (draft.step === "manage") return false;
    const custom = text.trim().replace(/^(สนใจ|เพิ่ม)\s*/i, "").slice(0, 60);
    if (!custom) {
      await replyLine(replyToken, "พิมพ์หัวข้อที่อยากติดตามมาได้เลยครับ เช่น “เซมิคอนดักเตอร์”");
      return true;
    }
    if (!draft.topics.includes(custom)) draft.topics.push(custom);
    await saveNewsDraft(upn, { ...draft, step: "topics" });
    await replyLineMessages(replyToken, [topicsPrompt(draft.topics)]);
    return true;
  }

  return false;
}

const NEWS_ACTIONS = new Set([
  "newsyes",
  "newsno",
  "newstopic",
  "newscustom",
  "newstopicsdone",
  "newscount",
  "newsadd",
  "newsdel",
  "newsdeli",
  "newseditcount",
  "newsmenu",
]);

export async function handleNewsOnboardingPostback(
  upn: string,
  data: URLSearchParams,
  replyToken: string
): Promise<boolean> {
  const a = data.get("a") || "";
  if (!NEWS_ACTIONS.has(a)) return false;

  let draft = await loadNewsDraft(upn);
  const prefs = await getNewsPrefs(upn);

  if (a === "newsmenu") {
    await openNewsSettings(upn, "reply", replyToken);
    return true;
  }

  if (a === "newsadd") {
    const topics = draft?.topics?.length ? draft.topics : prefs.topics;
    await saveNewsDraft(upn, { step: "topics", topics: [...topics], ts: Date.now() });
    await replyLineMessages(replyToken, [topicsPrompt(topics)]);
    return true;
  }

  if (a === "newsdel") {
    const topics = prefs.topics;
    await saveNewsDraft(upn, { step: "delete", topics: [...topics], ts: Date.now() });
    await replyLineMessages(replyToken, [deletePrompt(topics)]);
    return true;
  }

  if (a === "newsdeli") {
    const idx = Number(data.get("i") || 0);
    const topics = [...(prefs.topics || [])];
    if (idx >= 1 && idx <= topics.length) {
      const removed = topics.splice(idx - 1, 1)[0];
      await setNewsTopics(upn, topics);
      await saveNewsDraft(upn, { step: "manage", topics, ts: Date.now() });
      await replyLineMessages(replyToken, [
        {
          type: "text",
          text: `✅ ลบหัวข้อแล้ว: ${removed}`,
        },
        manageMenuMessage(await buildFollowListText(upn)),
      ]);
    } else {
      await replyLineMessages(replyToken, [deletePrompt(topics)]);
    }
    return true;
  }

  if (a === "newseditcount") {
    await saveNewsDraft(upn, {
      step: "count",
      topics: prefs.topics,
      ts: Date.now(),
    });
    await replyLineMessages(replyToken, [countPrompt()]);
    return true;
  }

  if (!draft && (a === "newsyes" || a === "newsno")) {
    draft = { step: "ask", topics: [], ts: Date.now() };
  }
  if (!draft && ["newstopic", "newscustom", "newstopicsdone", "newscount"].includes(a)) {
    draft = { step: "topics", topics: [...prefs.topics], ts: Date.now() };
  }
  if (!draft) {
    await openNewsSettings(upn, "reply", replyToken);
    return true;
  }

  if (a === "newsno") {
    await setNewsInterested(upn, false);
    await setNewsTopics(upn, []);
    await setNewsOnboardingDone(upn, true);
    await clearNewsDraft(upn);
    await saveNotifyKind(upn, "news", { enabled: false });
    await replyLine(
      replyToken,
      "รับทราบครับ จะยังไม่ส่งสรุปข่าวให้อัตโนมัติ\nถ้าเปลี่ยนใจ พิมพ์ “ตั้งค่าข่าว” ได้ตลอดครับ"
    );
    return true;
  }

  if (a === "newsyes") {
    await setNewsInterested(upn, true);
    await saveNotifyKind(upn, "news", { enabled: true });
    draft = { step: "topics", topics: draft.topics || [], ts: Date.now() };
    await saveNewsDraft(upn, draft);
    await replyLineMessages(replyToken, [topicsPrompt(draft.topics)]);
    return true;
  }

  if (a === "newstopic") {
    const id = decodeURIComponent(data.get("t") || "");
    const preset = presetById(id);
    const label = preset?.label || id;
    if (label && !draft.topics.includes(label)) {
      draft.topics.push(label);
    }
    draft.step = "topics";
    await saveNewsDraft(upn, draft);
    await replyLineMessages(replyToken, [topicsPrompt(draft.topics)]);
    return true;
  }

  if (a === "newscustom") {
    draft.step = "topics";
    await saveNewsDraft(upn, draft);
    await replyLine(replyToken, "พิมพ์หัวข้อที่อยากติดตามมาได้เลยครับ (เช่น “เซมิคอนดักเตอร์”, “หุ้นพลังงาน”)");
    return true;
  }

  if (a === "newstopicsdone") {
    if (!draft.topics.length) {
      await replyLineMessages(replyToken, [
        {
          type: "text",
          text: "ยังไม่ได้เลือกหัวข้อครับ เลือกอย่างน้อย 1 หัวข้อก่อนนะครับ",
          quickReply: (topicsPrompt([]) as { quickReply: object }).quickReply,
        },
      ]);
      return true;
    }
    await setNewsTopics(upn, draft.topics);
    // If already onboarded, skip count and return to manage menu
    if (prefs.onboardingDone) {
      await setNewsInterested(upn, true);
      await clearNewsDraft(upn);
      await openNewsSettings(upn, "reply", replyToken);
      return true;
    }
    draft.step = "count";
    await saveNewsDraft(upn, draft);
    await replyLineMessages(replyToken, [countPrompt()]);
    return true;
  }

  if (a === "newscount") {
    const n = clampNewsCount(data.get("n"));
    await saveNotifyKind(upn, "news", { enabled: true, count: n });
    await setNewsTopics(upn, draft.topics.length ? draft.topics : prefs.topics);
    await setNewsInterested(upn, true);
    await setNewsOnboardingDone(upn, true);
    await clearNewsDraft(upn);
    if (prefs.onboardingDone) {
      await openNewsSettings(upn, "reply", replyToken);
      return true;
    }
    await replyLine(
      replyToken,
      "✅ ตั้งค่าข่าวเรียบร้อยครับ\n\n" +
        `หัวข้อ: ${(draft.topics.length ? draft.topics : prefs.topics).join(", ") || "-"}\n` +
        `อัปเดต: ${countLabel(n)}\n\n` +
        "ตอนเช้าจะสรุปข่าวตามหัวข้อเหล่านี้ให้ และถาม “มีข่าวอะไรบ้าง” ได้ตลอดครับ\n" +
        "เปลี่ยนภายหลัง พิมพ์ “ตั้งค่าข่าว” ได้เลย\n" +
        `หรือเปิดหน้าตั้งค่า: ${SETTINGS_URL}`
    );
    return true;
  }

  return false;
}

export function isNewsOnboardingAction(a: string): boolean {
  return NEWS_ACTIONS.has(a);
}
