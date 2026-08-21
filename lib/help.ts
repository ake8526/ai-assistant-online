// What can I type? — the one list of commands, used by both the /help page and
// the assistant's own answer in LINE.
//
// It lives in one place on purpose. The commands themselves are spread across
// thirty intents and eight slash commands, and a manual that drifts from the
// code is worse than none: people try what it says, it fails, they stop
// trusting the whole thing. Add a capability → add its line here, and the page,
// the chat menu and the category replies all pick it up.

/** The Official Account users are talking to. */
export const LINE_OA_ID = process.env.LINE_OA_ID || "@777nxuvm";

export function appBase(): string {
  return (process.env.NEXT_PUBLIC_APP_BASE_URL || "https://ktis-ai-assistant.vercel.app").replace(/\/$/, "");
}

export function helpUrl(): string {
  return `${appBase()}/help`;
}

/**
 * Tapping a command on the page should put it in the chat, not explain it.
 * This LINE link opens the conversation with the text already in the input box —
 * the person still presses send, which is the right amount of control for
 * something that can book a meeting.
 */
export function sendToLineUrl(text: string): string {
  return `https://line.me/R/oaMessage/${encodeURIComponent(LINE_OA_ID)}/?${encodeURIComponent(text)}`;
}

export type HelpTopic = {
  key: string;
  emoji: string;
  /** short enough for a LINE quick-reply label (≤20 chars incl. emoji) */
  chip: string;
  title: string;
  hint: string;
  commands: string[];
  note?: string;
};

export const HELP_TOPICS: HelpTopic[] = [
  {
    key: "mine",
    emoji: "🗓",
    chip: "🗓 ตารางฉัน",
    title: "ตาราง & นัดของฉัน",
    hint: "ดูนัดตัวเอง วันนี้ พรุ่งนี้ ทั้งเดือน หรือเจาะจงเวลา",
    commands: [
      "ตารางวันนี้",
      "นัดพรุ่งนี้",
      "ตารางเดือนกรกฎาคม",
      "10 โมงติดอะไร",
      "เสาร์นี้ว่างไหม",
      "ว่างกี่โมงพรุ่งนี้",
    ],
    note: "ถามต่อสั้น ๆ ได้ ไม่ต้องพิมพ์ใหม่ทั้งประโยค เช่น “แล้วบ่ายล่ะ” · “วันศุกร์ล่ะ” (ระบบจำเรื่องที่คุยไว้ราว 30 นาที)",
  },
  {
    key: "others",
    emoji: "👥",
    chip: "👥 ตารางคนอื่น",
    title: "ตารางของคนอื่น",
    hint: "เห็นได้เท่าที่ Outlook ของเขาเปิดให้ — เหมือนที่คุณเปิดดูใน Outlook เอง",
    commands: [
      "ดูตารางเบสพรุ่งนี้",
      "ส้มมีนัดอะไรบ้างวันนี้",
      "ดูตาราง เบส ชนัญชิดา",
      "ตารางของ ชื่อ@ktisgroup.com เดือนนี้",
    ],
    note: "ชื่อเล่นซ้ำกันได้ (มี “เบส” 3 คน) ระบบจะให้เลือกเป็นตัวเลข — พิมพ์ชื่อจริงต่อท้ายหรือพิมพ์อีเมลก็ตรงที่สุด",
  },
  {
    key: "book",
    emoji: "📅",
    chip: "📅 นัดประชุม",
    title: "นัดประชุม · หาเวลาว่างตรงกัน",
    hint: "ยืนยันก่อนลง Outlook ทุกครั้ง — ระบบไม่แก้ปฏิทินเองเงียบ ๆ",
    commands: [
      "นัดประชุม",
      "นัดเบสพรุ่งนี้ 30 นาที เรื่อง sync",
      "หาเวลาที่เบสกับนนท์ว่างตรงกันวันจันทร์",
      "ยกเลิกนัดพรุ่งนี้",
      "จองตารางให้เราวันศุกร์นี้ทั้งวัน ลาพักร้อน",
    ],
    note: "พิมพ์ “นัดประชุม” เฉย ๆ ระบบจะเสนอรายชื่อคนที่คุณนัดบ่อยให้เลือก · คนนอกองค์กรใช้อีเมลได้ · ผู้ถูกเชิญกดรับ/ปฏิเสธ/ขอเวลาใหม่ได้ใน LINE",
  },
  {
    key: "summary",
    emoji: "📝",
    chip: "📝 สรุปประชุม",
    title: "สรุปประชุม",
    hint: "ต้องเปิด “บันทึกและถอดเสียง” ใน Teams ตอนประชุม ระบบจึงมี transcript ไปสรุป",
    commands: ["สรุปประชุม", "/test_meeting", "/test_meeting demo", "เตรียมนัด 1", "ประชุมไปกี่นาที"],
    note: "สรุปมาเป็นลิงก์อ่านบนมือถือ พร้อมงานที่ต้องตามและชื่อผู้รับผิดชอบ · “/test_meeting demo” = ดูรูปแบบก่อนได้ ไม่ต้องมี transcript",
  },
  {
    key: "tasks",
    emoji: "✅",
    chip: "✅ งานที่ต้องตาม",
    title: "งานที่ต้องติดตาม",
    hint: "งานที่ไม่ใช่ประชุม — ระบบเตือนให้ต้นชั่วโมง จันทร์–ศุกร์ 08:00–19:45",
    commands: ["ดูงานที่ต้องติดตาม", "เพิ่มงาน ทำสลิปการประชุม พรุ่งนี้ 17:00", "ปิดงาน 1"],
  },
  {
    key: "files",
    emoji: "📂",
    chip: "📂 ไฟล์",
    title: "ไฟล์ใน OneDrive",
    hint: "ค้น อ่าน สรุป และผูกไฟล์เข้ากับนัดประชุม",
    commands: ["หาไฟล์ งบ Q3", "สรุปอัน 1", "ผูกไฟล์นัด 1", "เอกสารนัด 1"],
    note: "ส่งรูปหรือไฟล์เข้าแชทตอนจองนัดได้ · พิมพ์ “เตรียมนัด 1” ระบบจะอ่านไฟล์ที่ผูกไว้ให้ก่อนเข้าประชุม",
  },
  {
    key: "news",
    emoji: "📰",
    chip: "📰 ข่าว",
    title: "ข่าว & บรีฟเช้า",
    hint: "เลือกหัวข้อ เวลาส่ง และแหล่งข่าวได้เองทั้งหมดในแชท",
    commands: ["ข่าววันนี้", "/ตั้งค่าข่าว", "ดูแหล่งข่าว", "เพิ่มแหล่งข่าว https://example.com/feed", "ลบฟีด 1"],
    note: "ตั้งเวลาส่งเช้าได้เอง · เลย 30 นาทีจากเวลาที่ตั้ง ระบบไม่ส่งย้อนหลัง เพราะตารางเก่าไปแล้ว",
  },
  {
    key: "commute",
    emoji: "🚗",
    chip: "🚗 เดินทาง",
    title: "สถานที่ & เดินทาง",
    hint: "ตั้งครั้งเดียวใช้ได้ทุกวัน — พิมพ์ที่อยู่ หรือปักพิกัดจากมือถือ",
    commands: ["ตั้งที่ทำงาน", "วางแผนเดินทางไปทำงานพรุ่งนี้", "เปิดแผนที่ไปที่ทำงาน", "ดูที่ทำงานที่ตั้งไว้"],
  },
  {
    key: "slash",
    emoji: "⌨️",
    chip: "⌨️ คำสั่ง /",
    title: "คำสั่ง / (พิมพ์ / แล้วเลือก)",
    hint: "ใช้ได้ตลอด แม้ค้างอยู่กลางขั้นตอนจองนัด",
    commands: ["/ตารางวันนี้", "/นัดพรุ่งนี้", "/ตั้งค่าข่าว", "/ล้างความจำ", "/ยกเลิก", "/ช่วยเหลือ"],
    note: "“/ล้างความจำ” = เริ่มเรื่องใหม่และยกเลิกงานที่ค้าง · “/ยกเลิก” = ทิ้งการจองที่พิมพ์ค้างไว้",
  },
];

export const HELP_TIPS = [
  "ไม่ต้องพิมพ์เต็มประโยค — ถามต่อว่า “แล้วบ่ายล่ะ” หรือ “วันศุกร์ล่ะ” ได้เลย",
  "ชื่อเล่นซ้ำกัน ระบบจะให้เลือกเลข พิมพ์ “1” หรือ “1กับ2” ได้",
  "หาชื่อไม่เจอ ให้พิมพ์อีเมลแทน เช่น “ดูตาราง ชื่อ@ktisgroup.com”",
  "การจองและยกเลิกปฏิทินต้องกดยืนยันทุกครั้ง ระบบไม่แก้ปฏิทินเอง",
  "ยังไม่ได้ผูกบัญชี M365 จะดูตารางไม่ได้ — พิมพ์ “ผูกบัญชี” เพื่อเริ่ม",
];

/** The short answer in chat: what to type, and where the full list lives. */
export function helpMenuText(): string {
  return [
    "📖 สั่งงานอะไรได้บ้าง",
    "",
    "พิมพ์ภาษาไทยธรรมดาได้เลยครับ เช่น",
    " • ตารางวันนี้",
    " • ดูตารางเบสพรุ่งนี้",
    " • นัดประชุม",
    " • ข่าววันนี้",
    "",
    "กดปุ่มด้านล่างเพื่อดูคำสั่งแยกหมวด",
    "หรือเปิดคู่มือเต็ม (ทุกคำสั่ง กดส่งได้เลย)",
    `👉 ${helpUrl()}`,
  ].join("\n");
}

export function helpTopicText(topic: HelpTopic): string {
  const lines = [
    `${topic.emoji} ${topic.title}`,
    "",
    topic.hint,
    "",
    ...topic.commands.map((c) => ` • ${c}`),
  ];
  if (topic.note) lines.push("", `💡 ${topic.note}`);
  lines.push("", `คู่มือเต็ม 👉 ${helpUrl()}`);
  return lines.join("\n");
}

/**
 * Did the person tap a category chip?
 *
 * Only an exact chip label counts — matching the plain title too meant
 * "สรุปประชุม", a command in its own right, opened the manual instead of
 * summarising anything. The chips carry an emoji precisely so they cannot
 * collide with something a person would type.
 */
export function findHelpTopic(text: string): HelpTopic | null {
  const t = (text || "").trim().toLowerCase();
  if (!t) return null;
  return (
    HELP_TOPICS.find((h) => h.chip.toLowerCase() === t) ||
    HELP_TOPICS.find((h) => `${h.emoji} ${h.title}`.toLowerCase() === t) ||
    null
  );
}
