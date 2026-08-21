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

/**
 * A command, plus the label a LINE button can carry.
 *
 * LINE rejects a quick-reply label over 20 characters but sends whatever text
 * you like — so the button reads "หาเวลาว่างตรงกัน" and sends the whole
 * "หาเวลาที่เบสกับนนท์ว่างตรงกันวันจันทร์".
 */
export type HelpCommand = { text: string; label: string };

export type HelpTopic = {
  key: string;
  emoji: string;
  /** short enough for a LINE quick-reply label (≤20 chars incl. emoji) */
  chip: string;
  title: string;
  hint: string;
  commands: HelpCommand[];
  note?: string;
  /**
   * Kept out of the menu, the /help page and the chips, but still answered if
   * someone types one of its commands. For a feature not ready to be
   * advertised yet — flip it back by deleting the flag.
   */
  hidden?: boolean;
};

/** Label defaults to the command when it already fits a button. */
const cmd = (text: string, label?: string): HelpCommand => ({ text, label: label || text });

export const HELP_TOPICS: HelpTopic[] = [
  {
    key: "mine",
    emoji: "🗓",
    chip: "🗓 ตารางฉัน",
    title: "ตาราง & นัดของฉัน",
    hint: "ดูนัดตัวเอง วันนี้ พรุ่งนี้ ทั้งเดือน หรือเจาะจงเวลา",
    commands: [
      cmd("ตารางวันนี้"),
      cmd("นัดพรุ่งนี้"),
      cmd("ตารางเดือนนี้"),
      cmd("ตารางเดือนกรกฎาคม", "ตารางเดือน ก.ค."),
      cmd("10 โมงติดอะไร"),
      cmd("เสาร์นี้ว่างไหม"),
      cmd("ว่างกี่โมงพรุ่งนี้"),
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
      cmd("ดูตารางเบสพรุ่งนี้"),
      cmd("ส้มมีนัดอะไรบ้างวันนี้", "ส้มมีนัดอะไรวันนี้"),
      cmd("ดูตาราง เบส ชนัญชิดา", "ชื่อเล่น + ชื่อจริง"),
      cmd("ดูตาราง natthakrit.b@ktisgroup.com", "ค้นด้วยอีเมล"),
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
      cmd("นัดประชุม"),
      cmd("นัดเบสพรุ่งนี้ 30 นาที เรื่อง sync", "นัดเบส 30 นาที"),
      cmd("หาเวลาที่เบสกับนนท์ว่างตรงกันวันจันทร์", "หาเวลาว่างตรงกัน"),
      cmd("ยกเลิกนัดพรุ่งนี้"),
      cmd("จองตารางให้เราวันศุกร์นี้ทั้งวัน ลาพักร้อน", "กันเวลาทั้งวัน"),
    ],
    note: "พิมพ์ “นัดประชุม” เฉย ๆ ระบบจะเสนอรายชื่อคนที่คุณนัดบ่อยให้เลือก · คนนอกองค์กรใช้อีเมลได้ · ผู้ถูกเชิญกดรับ/ปฏิเสธ/ขอเวลาใหม่ได้ใน LINE",
  },
  {
    key: "summary",
    emoji: "📝",
    chip: "📝 สรุปประชุม",
    title: "สรุปประชุม",
    hint: "ต้องเปิด “บันทึกและถอดเสียง” ใน Teams ตอนประชุม ระบบจึงมี transcript ไปสรุป",
    commands: [
      cmd("สรุปประชุม"),
      cmd("/test_meeting"),
      cmd("/test_meeting demo", "ดูตัวอย่างสรุป"),
      cmd("เตรียมนัด 1"),
      cmd("ประชุมไปกี่นาที"),
    ],
    note: "สรุปมาเป็นลิงก์อ่านบนมือถือ พร้อมงานที่ต้องตามและชื่อผู้รับผิดชอบ · “/test_meeting demo” = ดูรูปแบบก่อนได้ ไม่ต้องมี transcript",
  },
  {
    key: "tasks",
    emoji: "✅",
    chip: "✅ งานที่ต้องตาม",
    title: "งานที่ต้องติดตาม",
    hint: "งานที่ไม่ใช่ประชุม — ระบบเตือนให้ต้นชั่วโมง จันทร์–ศุกร์ 08:00–19:45",
    commands: [
      cmd("ดูงานที่ต้องติดตาม"),
      cmd("เพิ่มงาน ทำสลิปการประชุม พรุ่งนี้ 17:00", "เพิ่มงานใหม่"),
      cmd("เพิ่มงาน ส่งรายงาน ให้เบส วันศุกร์ 17:00", "ระบุคนรับผิดชอบ"),
      cmd("ปิดงาน 1"),
      cmd("ปิดงาน 1 2 3", "ปิดหลายงานพร้อมกัน"),
      cmd("ปิดงานทั้งหมด", "ปิดทั้งหมด"),
      cmd("ปิดงาน ทำสลิป", "ปิดงานด้วยชื่อ"),
      cmd("เพิ่มงานทดสอบ 3 งาน", "ขอข้อมูลตัวอย่าง"),
    ],
    note: "งานจากสรุปประชุมเข้ามาที่นี่เอง (ติด 🤖) · เกินกำหนดจะขึ้น ⚠️ · ปิดงานด้วยชื่อจะให้ยืนยันก่อนถ้าชื่อใกล้กันหลายงาน",
  },
  {
    key: "files",
    emoji: "📂",
    chip: "📂 ไฟล์",
    title: "ไฟล์ใน OneDrive",
    hint: "ค้น อ่าน สรุป และผูกไฟล์เข้ากับนัดประชุม",
    commands: [cmd("หาไฟล์ งบ Q3"), cmd("สรุปอัน 1"), cmd("ผูกไฟล์นัด 1"), cmd("เอกสารนัด 1")],
    note: "ส่งรูปหรือไฟล์เข้าแชทตอนจองนัดได้ · พิมพ์ “เตรียมนัด 1” ระบบจะอ่านไฟล์ที่ผูกไว้ให้ก่อนเข้าประชุม",
  },
  {
    key: "news",
    emoji: "📰",
    chip: "📰 ข่าว",
    title: "ข่าว & บรีฟเช้า",
    hint: "เลือกหัวข้อ เวลาส่ง และแหล่งข่าวได้เองทั้งหมดในแชท",
    commands: [
      cmd("ข่าววันนี้"),
      cmd("/ตั้งค่าข่าว"),
      cmd("ดูแหล่งข่าว"),
      cmd("เพิ่มแหล่งข่าว https://example.com/feed", "เพิ่มแหล่งข่าว"),
      cmd("ลบฟีด 1"),
    ],
    note: "ตั้งเวลาส่งเช้าได้เอง · เลย 30 นาทีจากเวลาที่ตั้ง ระบบไม่ส่งย้อนหลัง เพราะตารางเก่าไปแล้ว",
  },
  {
    key: "commute",
    hidden: true, // ยังไม่พร้อมโชว์ — ปิดชั่วคราว
    emoji: "🚗",
    chip: "🚗 เดินทาง",
    title: "สถานที่ & เดินทาง",
    hint: "ตั้งครั้งเดียวใช้ได้ทุกวัน — พิมพ์ที่อยู่ หรือปักพิกัดจากมือถือ",
    commands: [
      cmd("ตั้งที่ทำงาน"),
      cmd("วางแผนเดินทางไปทำงานพรุ่งนี้", "วางแผนเดินทาง"),
      cmd("เปิดแผนที่ไปที่ทำงาน", "เปิดแผนที่"),
      cmd("ดูที่ทำงานที่ตั้งไว้"),
    ],
  },
  {
    key: "slash",
    emoji: "⌨️",
    chip: "⌨️ คำสั่ง /",
    title: "คำสั่ง / (พิมพ์ / แล้วเลือก)",
    hint: "ใช้ได้ตลอด แม้ค้างอยู่กลางขั้นตอนจองนัด",
    commands: [
      cmd("/ตารางวันนี้"),
      cmd("/นัดพรุ่งนี้"),
      cmd("/ตั้งค่าข่าว"),
      cmd("/ล้างความจำ"),
      cmd("/ยกเลิก"),
      cmd("/ช่วยเหลือ"),
    ],
    note: "“/ล้างความจำ” = เริ่มเรื่องใหม่และยกเลิกงานที่ค้าง · “/ยกเลิก” = ทิ้งการจองที่พิมพ์ค้างไว้",
  },
];

/** What the menu, the page and the chips list — hidden categories excluded. */
export const visibleTopics = (): HelpTopic[] => HELP_TOPICS.filter((t) => !t.hidden);

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
    "แตะหมวดที่ต้องการในการ์ดด้านล่าง",
    "แล้วแตะคำสั่งได้เลย ไม่ต้องพิมพ์เอง",
  ].join("\n");
}

export function helpTopicText(topic: HelpTopic): string {
  const lines = [
    `${topic.emoji} ${topic.title}`,
    "",
    topic.hint,
    "",
    ...topic.commands.map((c) => ` • ${c.text}`),
  ];
  if (topic.note) lines.push("", `💡 ${topic.note}`);
  lines.push("", "👇 กดปุ่มด้านล่างเพื่อสั่งได้เลย");
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

// ---------------------------------------------------------------------------
// Flex cards
//
// A quick reply can only show 20 characters and LINE scrolls the strip
// sideways, so a nine-item menu showed three items and hid the rest. A Flex
// box takes an action of its own: the row displays the full command, the tap
// sends it as a message. Same effect as typing, no browser in the way.

const ROW_ARROW = { type: "text", text: "›", size: "lg", color: "#9aa3b2", flex: 0, align: "end" };

function tapRow(display: string, send: string, sub?: string) {
  const label: object[] = [{ type: "text", text: display, size: "sm", color: "#111111", weight: "bold", wrap: true }];
  if (sub) label.push({ type: "text", text: sub, size: "xxs", color: "#8b93a3", wrap: true, margin: "xs" });
  return {
    type: "box",
    layout: "horizontal",
    spacing: "sm",
    paddingAll: "10px",
    backgroundColor: "#f4f6f8",
    cornerRadius: "8px",
    margin: "sm",
    action: { type: "message", label: display.slice(0, 20), text: send },
    contents: [{ type: "box", layout: "vertical", flex: 1, contents: label }, ROW_ARROW],
  };
}

function card(title: string, subtitle: string, rows: object[]): object {
  return {
    type: "bubble",
    size: "mega",
    header: {
      type: "box",
      layout: "vertical",
      backgroundColor: "#06c755",
      paddingAll: "14px",
      contents: [
        { type: "text", text: title, color: "#ffffff", weight: "bold", size: "md", wrap: true },
        { type: "text", text: subtitle, color: "#e6fff0", size: "xs", wrap: true, margin: "xs" },
      ],
    },
    body: { type: "box", layout: "vertical", paddingAll: "12px", contents: rows },
  };
}

/** The category card: nine rows, all visible, one tap each. */
export function helpMenuFlex(): { altText: string; contents: object } {
  const rows = visibleTopics().map((t) => tapRow(`${t.emoji} ${t.title}`, t.chip, t.hint));
  return {
    altText: "คู่มือคำสั่ง — แตะหมวดที่ต้องการ",
    contents: card("📖 สั่งงานอะไรได้บ้าง", "แตะหมวดเพื่อดูคำสั่ง แล้วแตะคำสั่งเพื่อสั่งงานได้เลย", rows),
  };
}

/** One category: every command is a row, shown in full and sent on tap. */
export function helpTopicFlex(topic: HelpTopic): { altText: string; contents: object } {
  const rows: object[] = topic.commands.map((c) => tapRow(c.text, c.text));
  if (topic.note) {
    rows.push({
      type: "text",
      text: `💡 ${topic.note}`,
      size: "xxs",
      color: "#69707d",
      wrap: true,
      margin: "lg",
    });
  }
  rows.push(tapRow("◀ ดูหมวดอื่น", "/ช่วยเหลือ"));
  return {
    altText: `${topic.title} — แตะคำสั่งที่ต้องการ`,
    contents: card(`${topic.emoji} ${topic.title}`, topic.hint, rows),
  };
}
