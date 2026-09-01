// Slash commands: type "/" to pick a command. These always override mid-flow
// drafts (booking subject/time, news onboarding text, etc.).

export type SlashCommand = {
  /** Shown after / e.g. ล้างความจำ */
  cmd: string;
  /** LINE quick-reply label (≤20 chars) */
  label: string;
  /** Full message sent when tapped */
  message: string;
  /** Short hint in the menu body */
  hint: string;
  /**
   * What must be typed after the command, e.g. the meeting subject. Picking
   * such a command from the "/" menu fills the command in and waits, instead
   * of sending a bare command the handler cannot act on.
   */
  arg?: string;
  /**
   * Other names for the same command. People reach for the word they think of
   * first — /คำสั่ง, /คู่มือ, /help — and answering "ไม่รู้จักคำสั่ง" to any of them
   * teaches the wrong lesson. Aliases stay out of the menu so it reads as one
   * command, not four.
   */
  aliases?: string[];
  /**
   * เห็นเฉพาะคนที่มีสิทธิ์ "คำสั่งทดสอบ" (test.cmds ใน lib/roles) — สั่งได้ด้วย
   * ไม่ใช่แค่ซ่อนจากเมนู คนที่ไม่มีสิทธิ์พิมพ์เองก็ต้องได้ "ไม่รู้จักคำสั่ง"
   * ไม่งั้นซ่อนไปก็เท่านั้น ใครเห็นคนอื่นพิมพ์ก็พิมพ์ตามได้
   */
  restricted?: boolean;
};

export const SLASH_COMMANDS: SlashCommand[] = [
  { cmd: "ล้างความจำ", label: "/ล้างความจำ", message: "/ล้างความจำ", hint: "ล้างประวัติแชท + ยกเลิกงานค้าง" },
  { cmd: "ยกเลิก", label: "/ยกเลิก", message: "/ยกเลิก", hint: "ยกเลิกการจอง/พิมพ์ค้างไว้" },
  { cmd: "ตารางวันนี้", label: "/ตารางวันนี้", message: "/ตารางวันนี้", hint: "ดูนัดวันนี้" },
  { cmd: "นัดพรุ่งนี้", label: "/นัดพรุ่งนี้", message: "/นัดพรุ่งนี้", hint: "ดูนัดพรุ่งนี้" },
  { cmd: "ตั้งค่าข่าว", label: "/ตั้งค่าข่าว", message: "/ตั้งค่าข่าว", hint: "จัดการติดตามข่าว" },
  {
    cmd: "ช่วยเหลือ",
    label: "/ช่วยเหลือ",
    message: "/ช่วยเหลือ",
    hint: "คู่มือคำสั่ง — สั่งงานอะไรได้บ้าง",
    aliases: ["คำสั่ง", "คู่มือ", "ช่วยด้วย", "ช่วยหน่อย", "เมนู", "help", "menu", "start"],
  },
  // Replies cost nothing, so previewing a push-shaped message this way never
  // spends quota — which is the whole point while the monthly cap is gone.
  { cmd: "test", label: "/test", message: "/test", hint: "ดูตัวอย่างข้อความเช้า (ไม่กินโควตา)", restricted: true },
  {
    cmd: "test_meeting",
    label: "/test_meeting",
    message: "/test_meeting",
    hint: "ทดสอบสรุปประชุม — พิมพ์ชื่อเรื่องหรือเลขต่อท้าย",
    arg: "ชื่อเรื่องหรือเลขที่",
    restricted: true,
  },
];

/**
 * คำสั่งที่ผู้ใช้คนนี้เห็นได้ — ทุกที่ที่โชว์หรือรับคำสั่งต้องเรียกผ่านตัวนี้
 * ทั้งเมนูในเว็บ ปุ่มลัด ปุ่มใน LINE และการจับคู่ตอนพิมพ์เอง
 */
export function visibleCommands(canTest: boolean): SlashCommand[] {
  return canTest ? SLASH_COMMANDS : SLASH_COMMANDS.filter((c) => !c.restricted);
}

export function isSlashMenu(text: string): boolean {
  return text.trim() === "/" || text.trim() === "／";
}

/** Normalize "/ ล้างความจำ" → "ล้างความจำ", bare "ล้างความจำ" stays. */
export function parseSlashCommand(text: string): string | null {
  const t = text.trim();
  if (!t.startsWith("/") && !t.startsWith("／")) return null;
  const body = t.replace(/^[／/]\s*/, "").trim();
  if (!body) return null; // menu only
  return body;
}

/** `cmds` คือชุดที่ผู้ใช้คนนั้นเห็นได้ — นอกชุดนี้ต้องไม่จับคู่ ถือว่าไม่มีคำสั่งนั้น */
export function matchSlashCommand(body: string, cmds: SlashCommand[] = SLASH_COMMANDS): SlashCommand | null {
  const q = body.trim().replace(/^\//, "").toLowerCase();
  const named = (c: SlashCommand) => [c.cmd, ...(c.aliases || [])].map((s) => s.toLowerCase());
  const exact = cmds.find((c) => named(c).includes(q) || c.message.toLowerCase() === `/${q}`);
  if (exact) return exact;
  // A command may take an argument ("/test ประชุม"). Matching only whole
  // strings answered "ไม่รู้จักคำสั่ง" to a command the menu had just offered.
  const head = q.split(/\s+/)[0] || "";
  return cmds.find((c) => named(c).includes(head)) || null;
}

function quickReplyItems(cmds: SlashCommand[]) {
  return cmds.slice(0, 13).map((c) => ({
    type: "action",
    action: {
      type: "message",
      label: c.label.slice(0, 20),
      text: c.message,
    },
  }));
}

export function slashMenuMessage(cmds: SlashCommand[] = SLASH_COMMANDS): object {
  const lines = [
    "เลือกคำสั่งได้เลยครับ (พิมพ์ / แล้วเลือกปุ่ม)",
    "",
    ...cmds.map((c, i) => `${i + 1}) /${c.cmd} — ${c.hint}`),
  ];
  return {
    type: "text",
    text: lines.join("\n"),
    quickReply: { items: quickReplyItems(cmds) },
  };
}

/** Escape hatch while stuck in booking draft / free-text await. */
export function draftEscapeQuickReply() {
  const cmds = SLASH_COMMANDS.filter((c) => c.cmd === "ล้างความจำ" || c.cmd === "ยกเลิก");
  return { items: quickReplyItems(cmds) };
}

export function textWithDraftEscape(text: string): object {
  return { type: "text", text, quickReply: draftEscapeQuickReply() };
}

/** Map slash command → plain text the normal command brain understands. */
/** `rest` is whatever followed the command word, e.g. "ประชุม" in "/test ประชุม". */
export function slashToUserText(cmd: SlashCommand, rest = ""): string {
  switch (cmd.cmd) {
    case "ล้างความจำ":
      return "ล้างความจำ";
    case "ยกเลิก":
      return "__cancel_draft__";
    case "ตารางวันนี้":
      return "ตารางวันนี้";
    case "นัดพรุ่งนี้":
      return "นัดพรุ่งนี้";
    case "ตั้งค่าข่าว":
      return "ตั้งค่าข่าว";
    case "ช่วยเหลือ":
      return "ช่วยเรื่องอื่น";
    case "test":
      return rest.trim() ? "__preview_summary_link__" : "__preview_morning__";
    case "test_meeting":
      // The subject travels with the sentinel — which meeting to summarise is
      // the whole point of this command.
      return `__test_meeting__ ${rest.trim()}`.trim();
    default:
      return cmd.message;
  }
}
