// LINE news onboarding: ask → pick topics → set daily count.
import { clampNewsCount, saveNotifyKind } from "@/lib/notify";
import {
  NEWS_TOPIC_PRESETS,
  clearNewsDraft,
  loadNewsDraft,
  presetById,
  saveNewsDraft,
  setNewsInterested,
  setNewsOnboardingDone,
  setNewsTopics,
} from "@/lib/newsPrefs";
import { getLineId, pushLineMessages, replyLine, replyLineMessages } from "@/lib/line";

function qr(items: { label: string; data: string; displayText?: string }[]) {
  return {
    items: items.slice(0, 13).map((it) => ({
      type: "action",
      action: {
        type: "postback",
        label: it.label.slice(0, 20),
        data: it.data,
        displayText: (it.displayText || it.label).slice(0, 60),
      },
    })),
  };
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
  // Only show unselected topics as buttons
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

/** Start or resume onboarding for a user. */
export async function startNewsOnboarding(upn: string, via: "push" | "reply", replyToken?: string): Promise<void> {
  const existing = await loadNewsDraft(upn);
  let msg: object;
  if (existing?.step === "topics") {
    msg = topicsPrompt(existing.topics || []);
  } else if (existing?.step === "count") {
    msg = countPrompt();
  } else {
    await saveNewsDraft(upn, { step: "ask", topics: existing?.topics || [], ts: Date.now() });
    await setNewsOnboardingDone(upn, false);
    msg = askInterestedMessage();
  }
  if (via === "reply" && replyToken) {
    await replyLineMessages(replyToken, [msg]);
    return;
  }
  const lineId = await getLineId(upn);
  if (!lineId) throw new Error("ยังไม่ได้เชื่อม LINE");
  await pushLineMessages(lineId, [msg]);
}

export async function handleNewsOnboardingText(
  upn: string,
  text: string,
  replyToken: string
): Promise<boolean> {
  const draft = await loadNewsDraft(upn);
  if (!draft) return false;

  if (draft.step === "topics") {
    const custom = text.trim().replace(/^สนใจ\s*/i, "").slice(0, 60);
    if (!custom) {
      await replyLine(replyToken, "พิมพ์หัวข้อที่อยากติดตามมาได้เลยครับ เช่น “เซมิคอนดักเตอร์”");
      return true;
    }
    if (!draft.topics.includes(custom)) draft.topics.push(custom);
    await saveNewsDraft(upn, { ...draft, step: "topics" });
    await replyLineMessages(replyToken, [
      topicsPrompt(draft.topics),
    ]);
    return true;
  }

  return false;
}

export async function handleNewsOnboardingPostback(
  upn: string,
  data: URLSearchParams,
  replyToken: string
): Promise<boolean> {
  const a = data.get("a") || "";
  if (!["newsyes", "newsno", "newstopic", "newscustom", "newstopicsdone", "newscount"].includes(a)) {
    return false;
  }

  let draft = await loadNewsDraft(upn);
  if (!draft && (a === "newsyes" || a === "newsno")) {
    draft = { step: "ask", topics: [], ts: Date.now() };
  }
  if (!draft) {
    await replyLine(replyToken, "เริ่มตั้งค่าข่าวใหม่ได้ด้วยการพิมพ์ “ตั้งค่าข่าว” ครับ");
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
    draft.step = "count";
    await saveNewsDraft(upn, draft);
    await replyLineMessages(replyToken, [countPrompt()]);
    return true;
  }

  if (a === "newscount") {
    const n = clampNewsCount(data.get("n"));
    await saveNotifyKind(upn, "news", { enabled: true, count: n });
    await setNewsTopics(upn, draft.topics);
    await setNewsInterested(upn, true);
    await setNewsOnboardingDone(upn, true);
    await clearNewsDraft(upn);
    const countLabel = n === 0 ? "ทั้งหมดที่เกี่ยวข้องวันนี้" : `วันละ ${n} เรื่อง`;
    await replyLine(
      replyToken,
      "✅ ตั้งค่าข่าวเรียบร้อยครับ\n\n" +
        `หัวข้อ: ${draft.topics.join(", ")}\n` +
        `อัปเดต: ${countLabel}\n\n` +
        "ตอนเช้าจะสรุปข่าวตามหัวข้อเหล่านี้ให้ และถาม “มีข่าวอะไรบ้าง” ได้ตลอดครับ\n" +
        "เปลี่ยนหัวข้อภายหลัง พิมพ์ “ตั้งค่าข่าว” ได้เลย"
    );
    return true;
  }

  return false;
}

export function isNewsOnboardingAction(a: string): boolean {
  return ["newsyes", "newsno", "newstopic", "newscustom", "newstopicsdone", "newscount"].includes(a);
}
