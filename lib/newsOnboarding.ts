// LINE news onboarding + later “ตั้งค่าข่าว” manage menu.
import { clampNewsCount, getNotifyConfig, saveNotifyKind } from "@/lib/notify";
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
  type NewsOnboardingDraft,
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
  const owner = upn.toLowerCase().trim();

  // Match /api/oauth/google/status: only require refresh_token first.
  // account_* columns may be missing on older DBs — never treat that as "not linked".
  const { data: tok, error: tokErr } = await admin
    .from("oauth_tokens")
    .select("refresh_token")
    .eq("owner_upn", owner)
    .eq("provider", "google")
    .maybeSingle();
  if (tokErr) console.error("yt status token", tokErr.message);
  const linked = !!tok?.refresh_token;

  let email: string | null = null;
  let channel: string | null = null;
  if (linked) {
    try {
      const { data: cached } = await admin
        .from("oauth_tokens")
        .select("account_email, account_name, account_channel")
        .eq("owner_upn", owner)
        .eq("provider", "google")
        .maybeSingle();
      email = cached?.account_email || null;
      channel = cached?.account_channel || null;
    } catch {
      /* optional columns */
    }
  }

  let granted = linked;
  try {
    const { data: cons } = await admin
      .from("consents")
      .select("granted")
      .eq("owner_upn", owner)
      .eq("capability", "src_youtube")
      .maybeSingle();
    if (cons && cons.granted === false) granted = false;
  } catch {
    /* ignore */
  }

  return { linked, email, channel, granted };
}

function qr(items: { label: string; data?: string; uri?: string; message?: string; displayText?: string }[]) {
  return {
    items: items.slice(0, 13).map((it) => {
      if (it.uri) {
        return {
          type: "action",
          action: { type: "uri", label: it.label.slice(0, 20), uri: it.uri },
        };
      }
      if (it.message) {
        return {
          type: "action",
          action: { type: "message", label: it.label.slice(0, 20), text: it.message.slice(0, 300) },
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

  const actions: { label: string; data: string; displayText?: string }[] = [];
  if (n > 0) {
    actions.push({
      label: `✅ เสร็จแล้ว (${n})`,
      data: "a=newstopicsdone",
      displayText: "เลือกหัวข้อเสร็จแล้ว",
    });
  }

  // Show every preset so selected ones can be toggled off (✓ = selected)
  for (const p of NEWS_TOPIC_PRESETS) {
    const on = selected.includes(p.label);
    actions.push({
      label: (on ? `✓${p.label}` : p.label).slice(0, 20),
      data: `a=newstopic&t=${p.id}`,
      displayText: on ? `เอา ${p.label} ออก` : `เพิ่ม ${p.label}`,
    });
  }

  // Custom topics (typed) — show as ✓ buttons to remove
  for (const t of selected) {
    if (NEWS_TOPIC_PRESETS.some((p) => p.label === t)) continue;
    actions.push({
      label: `✓${t}`.slice(0, 20),
      data: `a=newstopic&t=${encodeURIComponent(t)}`,
      displayText: `เอา ${t} ออก`,
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
      "กดปุ่มทีละหัวข้อได้เรื่อย ๆ · กดหัวข้อที่มี ✓ อีกครั้งเพื่อเอาออก\n" +
      "หรือพิมพ์หัวข้อเอง เช่น “เซมิคอนดักเตอร์”\n\n" +
      `หัวข้อแนะนำ:\n${NEWS_TOPIC_PRESETS.map((p, i) => `${i + 1}) ${p.label}`).join("\n")}` +
      picked +
      (n > 0 ? "\n\nครบแล้วกด “เสร็จแล้ว” ได้เลย" : "\n\nเลือกอย่างน้อย 1 หัวข้อ แล้วกด “เสร็จแล้ว”"),
    quickReply: qr(actions),
  };
}

function countPrompt(): object {
  return {
    type: "text",
    text:
      "ต่อไปตั้งการแจ้งเตือนครับ 📬\n\n" +
      "① ต้องการให้อัปเดตข่าววันละกี่เรื่อง?\n\n" +
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

function timePrompt(kind: "news" | "brief" = "news"): object {
  const isBrief = kind === "brief";
  const action = isBrief ? "brieftime" : "newstime";
  const times = ["06:00", "07:00", "08:00", "09:00", "12:00", "18:00"];
  const actions = times.map((t) => ({
    label: t,
    data: `a=${action}&t=${t}`,
    displayText: isBrief ? `บรีฟเช้าตอน ${t}` : `ส่งข่าวตอน ${t}`,
  }));
  if (isBrief) {
    actions.push({
      label: "ค่าเริ่มต้น จ–ศ 07:00",
      data: "a=briefskip",
      displayText: "ใช้ค่าเริ่มต้นบรีฟเช้า",
    });
  }
  return {
    type: "text",
    text: isBrief
      ? "ต่อไปตั้งสรุปตารางเช้า (Morning Brief) ครับ 📅\n\n" +
        "① ส่งสรุปนัดวันนี้เข้า LINE กี่โมง?\n(เวลาไทย 24 ชม. · ระบบส่งข่าวก่อน แล้วตามด้วยบรีฟ)"
      : "② ส่งสรุปข่าวเข้า LINE กี่โมงครับ?\n(เวลาไทย 24 ชม.)",
    quickReply: qr(actions),
  };
}

const DAY_LABELS = ["อา", "จ", "อ", "พ", "พฤ", "ศ", "ส"];

function daysPrompt(selected: number[], kind: "news" | "brief" = "news"): object {
  const isBrief = kind === "brief";
  const dayAction = isBrief ? "briefdays" : "newsdays";
  const doneAction = isBrief ? "briefdaysdone" : "newsdaysdone";
  const selText = selected.length ? formatDays(selected) : "(ยังไม่เลือก)";
  const actions: { label: string; data: string; displayText?: string }[] = [];

  if (selected.length) {
    const pack = formatDays(selected);
    actions.push({
      label: pack === "จ–ศ" || pack === "ทุกวัน" ? `✅ เสร็จ · ${pack}` : `✅ เสร็จ (${selected.length} วัน)`,
      data: `a=${doneAction}`,
      displayText:
        pack === "จ–ศ"
          ? isBrief
            ? "ตั้งบรีฟเป็น จ–ศ"
            : "ตั้งส่งข่าวเป็น จ–ศ"
          : isBrief
            ? "ตั้งวันบรีฟเสร็จแล้ว"
            : "ตั้งวันส่งข่าวเสร็จแล้ว",
    });
  }

  actions.push(
    { label: "จ–ศ", data: `a=${dayAction}&p=weekday`, displayText: "ส่งจันทร์–ศุกร์" },
    { label: "ทุกวัน", data: `a=${dayAction}&p=everyday`, displayText: "ส่งทุกวัน" }
  );

  // Show every day so user can toggle off selected ones (✓ = selected)
  for (const d of [1, 2, 3, 4, 5, 6, 0]) {
    const on = selected.includes(d);
    actions.push({
      label: on ? `✓${DAY_LABELS[d]}` : DAY_LABELS[d],
      data: `a=${dayAction}&d=${d}`,
      displayText: on ? `เอาวัน${DAY_LABELS[d]}ออก` : `เพิ่มวัน${DAY_LABELS[d]}`,
    });
  }

  if (!selected.length) {
    actions.push({
      label: "✅ เสร็จ",
      data: `a=${doneAction}`,
      displayText: isBrief ? "ตั้งวันบรีฟเสร็จแล้ว" : "ตั้งวันส่งข่าวเสร็จแล้ว",
    });
  }

  return {
    type: "text",
    text: isBrief
      ? "② สรุปตารางเช้า ส่งวันไหนบ้างครับ?\n" +
        "กดวันทีละวันได้หลายอัน · กดวันที่มี ✓ อีกครั้งเพื่อเอาออก\n" +
        "หรือเลือกชุดสำเร็จรูป จ–ศ / ทุกวัน\n\n" +
        `เลือกแล้ว: ${selText}`
      : "③ ส่งวันไหนบ้างครับ?\n" +
        "กดวันทีละวันได้หลายอัน · กดวันที่มี ✓ อีกครั้งเพื่อเอาออก\n" +
        "หรือเลือกชุดสำเร็จรูป จ–ศ / ทุกวัน\n\n" +
        `เลือกแล้ว: ${selText}`,
    quickReply: qr(actions),
  };
}

function countLabel(n: number): string {
  return n === 0 ? "ทั้งหมดที่เกี่ยวข้องวันนี้" : `วันละ ${n} เรื่อง`;
}

function formatDays(days: number[]): string {
  if (!days.length) return "-";
  const sorted = [...days].sort((a, b) => a - b);
  if (sorted.length === 7) return "ทุกวัน";
  if (sorted.join(",") === "1,2,3,4,5") return "จ–ศ";
  return sorted.map((d) => DAY_LABELS[d]).join(" ");
}

/** Normalize day sets that match presets (e.g. จ–ศ → [1..5]). */
function normalizeDays(days: number[]): number[] {
  const sorted = Array.from(new Set(days.filter((d) => d >= 0 && d <= 6))).sort((a, b) => a - b);
  if (sorted.join(",") === "1,2,3,4,5") return [1, 2, 3, 4, 5];
  if (sorted.length === 7) return [0, 1, 2, 3, 4, 5, 6];
  return sorted;
}

async function finishNewsNotify(
  upn: string,
  draft: {
    topics: string[];
    count?: number;
    time?: string;
    days?: number[];
    briefTime?: string;
    briefDays?: number[];
  },
  replyToken: string
): Promise<void> {
  const count = draft.count ?? 3;
  const time = draft.time || "07:00";
  const days = normalizeDays(draft.days?.length ? draft.days : [1, 2, 3, 4, 5]);
  await setNewsTopics(upn, draft.topics);
  await setNewsInterested(upn, true);
  await saveNotifyKind(upn, "news", { enabled: true, count, time, days });
  await setNewsOnboardingDone(upn, true);

  const next: NewsOnboardingDraft = {
    step: "brief_time",
    topics: draft.topics,
    count,
    time,
    days,
    briefTime: draft.briefTime,
    briefDays: draft.briefDays,
    ts: Date.now(),
  };
  await saveNewsDraft(upn, next);

  const summary =
    "✅ ตั้งค่าสรุปข่าวเรียบร้อยครับ\n\n" +
    `หัวข้อ: ${draft.topics.join(", ") || "-"}\n` +
    `จำนวน: ${countLabel(count)}\n` +
    `เวลาส่ง: ${time} น.\n` +
    `วันที่ส่ง: ${formatDays(days)}\n\n` +
    "ต่อไปตั้งสรุปตารางเช้า (Morning Brief) ครับ 👇";

  await replyLineMessages(replyToken, [{ type: "text", text: summary }, timePrompt("brief")]);
}

async function finishBriefNotify(
  upn: string,
  draft: {
    topics: string[];
    count?: number;
    time?: string;
    days?: number[];
    briefTime?: string;
    briefDays?: number[];
  },
  replyToken: string
): Promise<void> {
  const briefTime = draft.briefTime || "07:00";
  const briefDays = normalizeDays(draft.briefDays?.length ? draft.briefDays : [1, 2, 3, 4, 5]);
  await saveNotifyKind(upn, "brief", { enabled: true, time: briefTime, days: briefDays });
  await setNewsOnboardingDone(upn, true);
  await clearNewsDraft(upn);

  await replyLineMessages(replyToken, [await onboardingDoneMessage(upn, draft)]);
}

/** Full summary after finishing notify setup + ask edit follows vs other help. */
async function onboardingDoneMessage(
  upn: string,
  draft?: {
    topics?: string[];
    count?: number;
    time?: string;
    days?: number[];
    briefTime?: string;
    briefDays?: number[];
  }
): Promise<object> {
  const prefs = await getNewsPrefs(upn);
  const [feeds, yt, notify] = await Promise.all([
    listManagedFeeds(upn).catch(() => []),
    getYouTubeFollowStatus(upn).catch(() => ({
      linked: false,
      email: null,
      channel: null,
      granted: false,
    })),
    getNotifyConfig(upn).catch(() => null),
  ]);

  const newsOn = prefs.interested && notify?.news.enabled !== false;
  const topics = (draft?.topics?.length ? draft.topics : prefs.topics) || [];
  const count = draft?.count ?? prefs.count;
  const newsTime = draft?.time || notify?.news.time || "07:00";
  const newsDays = normalizeDays(draft?.days?.length ? draft.days : notify?.news.days || [1, 2, 3, 4, 5]);
  const briefTime = draft?.briefTime || notify?.brief.time || "07:00";
  const briefDays = normalizeDays(
    draft?.briefDays?.length ? draft.briefDays : notify?.brief.days || [1, 2, 3, 4, 5]
  );
  const briefOn = notify?.brief.enabled !== false;

  const lines: string[] = ["✅ ตั้งค่าเรียบร้อยแล้วครับ", "", "📋 สรุปที่ตั้งไว้ทั้งหมด", ""];

  lines.push("📰 สรุปข่าวที่ติดตาม");
  if (!newsOn) {
    lines.push("  • สถานะ: ปิด");
  } else {
    lines.push("  • สถานะ: เปิด");
    lines.push(`  • จำนวน: ${countLabel(count)}`);
    lines.push(`  • เวลาส่ง: ${newsTime} น. · ${formatDays(newsDays)}`);
    if (topics.length) {
      lines.push("  • หัวข้อ:");
      topics.forEach((t, i) => lines.push(`      ${i + 1}. ${t}`));
    } else {
      lines.push("  • หัวข้อ: (ยังไม่มี)");
    }
  }
  lines.push("");

  lines.push("📅 สรุปตารางเช้า (Morning Brief)");
  lines.push(briefOn ? "  • สถานะ: เปิด" : "  • สถานะ: ปิด");
  if (briefOn) {
    lines.push(`  • เวลาส่ง: ${briefTime} น. · ${formatDays(briefDays)}`);
  }
  lines.push("");

  lines.push("แหล่งติดตาม");
  if (yt.linked) {
    const who = [yt.channel ? `ช่อง: ${yt.channel}` : null, yt.email].filter(Boolean).join(" · ");
    lines.push(`  • YouTube: ✅ เชื่อมแล้ว${who ? ` (${who})` : ""}`);
  } else {
    lines.push("  • YouTube: ยังไม่ได้เชื่อม");
  }
  if (feeds.length) {
    lines.push("  • RSS / Facebook:");
    feeds.forEach((f, i) => {
      const kind = f.kind === "facebook" ? "FB" : "RSS";
      lines.push(`      ${i + 1}. [${kind}] ${(f.label || "").trim() || f.ref}`);
    });
  } else {
    lines.push("  • RSS / Facebook: (ยังไม่มี)");
  }

  lines.push("");
  lines.push("ต้องการแก้ไขรายการที่ติดตาม หรือให้ช่วยเหลือเรื่องอื่นต่อไหมครับ?");

  return {
    type: "text",
    text: lines.join("\n"),
    quickReply: qr([
      { label: "✏️ แก้รายการติดตาม", data: "a=newsmenu", displayText: "แก้ไขรายการที่ติดตาม" },
      { label: "⏰ แก้เวลาแจ้งเตือน", data: "a=newsschedule", displayText: "แก้เวลาแจ้งเตือน" },
      { label: "📅 แก้เวลาบรีฟเช้า", data: "a=briefschedule", displayText: "แก้เวลาสรุปตารางเช้า" },
      { label: "💬 ช่วยเรื่องอื่น", data: "a=newsotherhelp", displayText: "ช่วยเหลือเรื่องอื่น" },
      { label: "🌐 หน้าตั้งค่า", uri: SETTINGS_URL },
    ]),
  };
}

function otherHelpMessage(): object {
  return {
    type: "text",
    text:
      "ได้เลยครับ พิมพ์สิ่งที่ต้องการมาได้เลย เช่น\n\n" +
      "• ตารางวันนี้ / นัดพรุ่งนี้\n" +
      "• หาเวลาว่างกับคุณ…\n" +
      "• สรุปประชุม / ตั้งงานเตือน\n" +
      "• เตรียมตัวนัดประชุม\n\n" +
      "หรือถ้าอยากกลับไปแก้ข่าว/แจ้งเตือน พิมพ์ “ตั้งค่าข่าว” ได้ครับ",
    quickReply: qr([
      { label: "📅 ตารางวันนี้", message: "ตารางวันนี้" },
      { label: "🗓 นัดพรุ่งนี้", message: "นัดพรุ่งนี้" },
      { label: "📰 ตั้งค่าข่าว", message: "ตั้งค่าข่าว" },
      { label: "/ล้างความจำ", message: "/ล้างความจำ" },
      { label: "🌐 หน้าตั้งค่า", uri: SETTINGS_URL },
    ]),
  };
}

async function buildFollowListText(upn: string): Promise<string> {
  const prefs = await getNewsPrefs(upn);
  const [feeds, yt, notify] = await Promise.all([
    listManagedFeeds(upn).catch(() => []),
    getYouTubeFollowStatus(upn).catch(() => ({
      linked: false,
      email: null,
      channel: null,
      granted: false,
    })),
    getNotifyConfig(upn).catch(() => null),
  ]);
  const newsN = notify?.news;
  const lines = ["📰 รายการที่คุณติดตามอยู่ตอนนี้", ""];

  if (!prefs.interested || newsN?.enabled === false) {
    lines.push("สถานะสรุปข่าว: ปิดอัตโนมัติ");
  } else {
    lines.push(
      `สถานะสรุปข่าว: เปิด · ${countLabel(prefs.count)} · เวลา ${newsN?.time || "07:00"} น. · ${formatDays(newsN?.days || [1, 2, 3, 4, 5])}`
    );
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
  lines.push("ต้องการแก้ไขรายการที่ติดตาม หรือให้ช่วยเหลือเรื่องอื่นต่อไหมครับ?");
  return lines.join("\n");
}

function manageMenuMessage(listText: string): object {
  return {
    type: "text",
    text: listText,
    quickReply: qr([
      { label: "➕ เพิ่มหัวข้อ", data: "a=newsadd", displayText: "เพิ่มหัวข้อข่าว" },
      { label: "🗑 ลบหัวข้อ", data: "a=newsdel", displayText: "ลบหัวข้อข่าว" },
      { label: "⏰ แก้เวลาแจ้งเตือน", data: "a=newsschedule", displayText: "แก้เวลาแจ้งเตือนข่าว" },
      { label: "📅 แก้เวลาบรีฟเช้า", data: "a=briefschedule", displayText: "แก้เวลาสรุปตารางเช้า" },
      { label: "💬 ช่วยเรื่องอื่น", data: "a=newsotherhelp", displayText: "ช่วยเหลือเรื่องอื่น" },
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

/** Push notify schedule wizard (count → time → days → brief) for preview / re-edit. */
export async function previewNewsNotifySetup(upn: string): Promise<void> {
  const prefs = await getNewsPrefs(upn);
  await saveNewsDraft(upn, {
    step: "count",
    topics: prefs.topics.length ? prefs.topics : ["เทคโนโลยี"],
    count: prefs.count,
    ts: Date.now(),
  });
  await send("push", upn, [
    {
      type: "text",
      text:
        "ตัวอย่างตั้งเวลาแจ้งเตือนครับ ⏰\n" +
        "หลังเลือกหัวข้อเสร็จ จะถาม ① จำนวนข่าว ② เวลา/วันส่งข่าว แล้วต่อด้วย ③ เวลา/วันสรุปตารางเช้า — ลองกดได้เลย",
    },
    countPrompt(),
  ]);
}

/** Push Morning Brief schedule wizard only. */
export async function previewBriefNotifySetup(upn: string): Promise<void> {
  const prefs = await getNewsPrefs(upn);
  const notify = await getNotifyConfig(upn).catch(() => null);
  await saveNewsDraft(upn, {
    step: "brief_days",
    topics: prefs.topics,
    count: prefs.count,
    time: notify?.news.time,
    days: notify?.news.days,
    briefTime: notify?.brief.time || "07:00",
    briefDays: [1, 2, 3, 4, 5],
    ts: Date.now(),
  });
  await send("push", upn, [
    {
      type: "text",
      text:
        "ตัวอย่างเลือกวันสรุปตารางเช้าครับ 📅\n" +
        "ตอนนี้เลือก จ–ศ ไว้แล้ว — กดวันที่มี ✓ เพื่อเอาออกได้ หรือกด ✅ เสร็จ · จ–ศ",
    },
    daysPrompt([1, 2, 3, 4, 5], "brief"),
  ]);
}

/** Push the post-setup summary card (for preview). */
export async function pushSetupCompleteSummary(upn: string): Promise<void> {
  await send("push", upn, [await onboardingDoneMessage(upn)]);
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
  } else if (existing?.step === "time") {
    msg = timePrompt();
  } else if (existing?.step === "days") {
    msg = daysPrompt(existing.days || [], "news");
  } else if (existing?.step === "brief_time") {
    msg = timePrompt("brief");
  } else if (existing?.step === "brief_days") {
    msg = daysPrompt(existing.briefDays || [], "brief");
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
  "newstime",
  "newsdays",
  "newsdaysdone",
  "brieftime",
  "briefdays",
  "briefdaysdone",
  "briefskip",
  "briefschedule",
  "newsadd",
  "newsdel",
  "newsdeli",
  "newseditcount",
  "newsschedule",
  "newsotherhelp",
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

  if (a === "newsotherhelp") {
    await clearNewsDraft(upn);
    await replyLineMessages(replyToken, [otherHelpMessage()]);
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

  if (a === "newseditcount" || a === "newsschedule") {
    await saveNewsDraft(upn, {
      step: "count",
      topics: prefs.topics,
      count: prefs.count,
      ts: Date.now(),
    });
    await replyLineMessages(replyToken, [countPrompt()]);
    return true;
  }

  if (a === "briefschedule") {
    const notify = await getNotifyConfig(upn).catch(() => null);
    await saveNewsDraft(upn, {
      step: "brief_time",
      topics: prefs.topics,
      count: prefs.count,
      time: notify?.news.time,
      days: notify?.news.days,
      briefTime: notify?.brief.time,
      briefDays: notify?.brief.days,
      ts: Date.now(),
    });
    await replyLineMessages(replyToken, [timePrompt("brief")]);
    return true;
  }

  if (!draft && (a === "newsyes" || a === "newsno")) {
    draft = { step: "ask", topics: [], ts: Date.now() };
  }
  if (!draft && ["newstopic", "newscustom", "newstopicsdone", "newscount"].includes(a)) {
    draft = { step: "topics", topics: [...prefs.topics], ts: Date.now() };
  }
  if (
    !draft &&
    ["brieftime", "briefdays", "briefdaysdone", "briefskip"].includes(a)
  ) {
    draft = { step: "brief_time", topics: [...prefs.topics], ts: Date.now() };
  }
  if (!draft) {
    await openNewsSettings(upn, "reply", replyToken);
    return true;
  }

  if (a === "newsno") {
    await setNewsInterested(upn, false);
    await setNewsTopics(upn, []);
    await saveNotifyKind(upn, "news", { enabled: false });
    await setNewsOnboardingDone(upn, true);
    await saveNewsDraft(upn, { step: "brief_time", topics: [], ts: Date.now() });
    await replyLineMessages(replyToken, [
      {
        type: "text",
        text:
          "รับทราบครับ จะยังไม่ส่งสรุปข่าวให้อัตโนมัติ\n" +
          "ถ้าเปลี่ยนใจ พิมพ์ “ตั้งค่าข่าว” ได้ตลอดครับ\n\n" +
          "ต่อไปตั้งสรุปตารางเช้า (Morning Brief) ครับ 👇",
      },
      timePrompt("brief"),
    ]);
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
    if (label) {
      if (draft.topics.includes(label)) {
        draft.topics = draft.topics.filter((t) => t !== label);
      } else {
        draft.topics.push(label);
      }
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
    // After topics → continue to notify schedule (count → time → days)
    draft.step = "count";
    await saveNewsDraft(upn, draft);
    await replyLineMessages(replyToken, [countPrompt()]);
    return true;
  }

  if (a === "newscount") {
    const n = clampNewsCount(data.get("n"));
    draft.count = n;
    draft.step = "time";
    await saveNewsDraft(upn, draft);
    await replyLineMessages(replyToken, [timePrompt()]);
    return true;
  }

  if (a === "newstime") {
    const t = data.get("t") || "07:00";
    draft.time = /^\d{1,2}:\d{2}$/.test(t) ? t.padStart(5, "0") : "07:00";
    draft.step = "days";
    draft.days = draft.days || [];
    await saveNewsDraft(upn, draft);
    await replyLineMessages(replyToken, [daysPrompt(draft.days, "news")]);
    return true;
  }

  if (a === "newsdays") {
    const preset = data.get("p") || "";
    if (preset === "weekday") {
      draft.days = [1, 2, 3, 4, 5];
      await finishNewsNotify(upn, draft, replyToken);
      return true;
    }
    if (preset === "everyday") {
      draft.days = [0, 1, 2, 3, 4, 5, 6];
      await finishNewsNotify(upn, draft, replyToken);
      return true;
    }
    const d = Number(data.get("d"));
    if (Number.isInteger(d) && d >= 0 && d <= 6) {
      const cur = new Set(draft.days || []);
      if (cur.has(d)) cur.delete(d);
      else cur.add(d);
      draft.days = Array.from(cur).sort((a, b) => a - b);
    }
    draft.step = "days";
    await saveNewsDraft(upn, draft);
    await replyLineMessages(replyToken, [daysPrompt(draft.days || [], "news")]);
    return true;
  }

  if (a === "newsdaysdone") {
    if (!draft.days?.length) {
      await replyLineMessages(replyToken, [
        {
          type: "text",
          text: "เลือกอย่างน้อย 1 วันก่อนนะครับ หรือกด “จ–ศ” / “ทุกวัน”",
          quickReply: (daysPrompt([], "news") as { quickReply: object }).quickReply,
        },
      ]);
      return true;
    }
    await finishNewsNotify(upn, draft, replyToken);
    return true;
  }

  if (a === "briefskip") {
    draft.briefTime = "07:00";
    draft.briefDays = [1, 2, 3, 4, 5];
    await finishBriefNotify(upn, draft, replyToken);
    return true;
  }

  if (a === "brieftime") {
    const t = data.get("t") || "07:00";
    draft.briefTime = /^\d{1,2}:\d{2}$/.test(t) ? t.padStart(5, "0") : "07:00";
    draft.step = "brief_days";
    draft.briefDays = draft.briefDays || [];
    await saveNewsDraft(upn, draft);
    await replyLineMessages(replyToken, [daysPrompt(draft.briefDays, "brief")]);
    return true;
  }

  if (a === "briefdays") {
    const preset = data.get("p") || "";
    if (preset === "weekday") {
      draft.briefDays = [1, 2, 3, 4, 5];
      await finishBriefNotify(upn, draft, replyToken);
      return true;
    }
    if (preset === "everyday") {
      draft.briefDays = [0, 1, 2, 3, 4, 5, 6];
      await finishBriefNotify(upn, draft, replyToken);
      return true;
    }
    const d = Number(data.get("d"));
    if (Number.isInteger(d) && d >= 0 && d <= 6) {
      const cur = new Set(draft.briefDays || []);
      if (cur.has(d)) cur.delete(d);
      else cur.add(d);
      draft.briefDays = Array.from(cur).sort((a, b) => a - b);
    }
    draft.step = "brief_days";
    await saveNewsDraft(upn, draft);
    await replyLineMessages(replyToken, [daysPrompt(draft.briefDays || [], "brief")]);
    return true;
  }

  if (a === "briefdaysdone") {
    if (!draft.briefDays?.length) {
      await replyLineMessages(replyToken, [
        {
          type: "text",
          text: "เลือกอย่างน้อย 1 วันก่อนนะครับ หรือกด “จ–ศ” / “ทุกวัน”",
          quickReply: (daysPrompt([], "brief") as { quickReply: object }).quickReply,
        },
      ]);
      return true;
    }
    await finishBriefNotify(upn, draft, replyToken);
    return true;
  }

  return false;
}

export function isNewsOnboardingAction(a: string): boolean {
  return NEWS_ACTIONS.has(a);
}
