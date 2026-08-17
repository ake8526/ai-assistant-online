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
};

export const SLASH_COMMANDS: SlashCommand[] = [
  { cmd: "ล้างความจำ", label: "/ล้างความจำ", message: "/ล้างความจำ", hint: "ล้างประวัติแชท + ยกเลิกงานค้าง" },
  { cmd: "ยกเลิก", label: "/ยกเลิก", message: "/ยกเลิก", hint: "ยกเลิกการจอง/พิมพ์ค้างไว้" },
  { cmd: "ตารางวันนี้", label: "/ตารางวันนี้", message: "/ตารางวันนี้", hint: "ดูนัดวันนี้" },
  { cmd: "นัดพรุ่งนี้", label: "/นัดพรุ่งนี้", message: "/นัดพรุ่งนี้", hint: "ดูนัดพรุ่งนี้" },
  { cmd: "ตั้งค่าข่าว", label: "/ตั้งค่าข่าว", message: "/ตั้งค่าข่าว", hint: "จัดการติดตามข่าว" },
  { cmd: "ช่วยเหลือ", label: "/ช่วยเหลือ", message: "/ช่วยเหลือ", hint: "เมนูความช่วยเหลือ" },
  // Replies cost nothing, so previewing a push-shaped message this way never
  // spends quota — which is the whole point while the monthly cap is gone.
  { cmd: "test", label: "/test", message: "/test", hint: "ดูตัวอย่างสรุปประชุมแบบลิงก์ (ไม่กินโควตา)" },
];

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

export function matchSlashCommand(body: string): SlashCommand | null {
  const q = body.trim().replace(/^\//, "").toLowerCase();
  return (
    SLASH_COMMANDS.find((c) => c.cmd.toLowerCase() === q || c.message.toLowerCase() === `/${q}`) || null
  );
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

export function slashMenuMessage(): object {
  const lines = [
    "เลือกคำสั่งได้เลยครับ (พิมพ์ / แล้วเลือกปุ่ม)",
    "",
    ...SLASH_COMMANDS.map((c, i) => `${i + 1}) /${c.cmd} — ${c.hint}`),
  ];
  return {
    type: "text",
    text: lines.join("\n"),
    quickReply: { items: quickReplyItems(SLASH_COMMANDS) },
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
export function slashToUserText(cmd: SlashCommand): string {
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
      return "__preview_summary_link__";
    default:
      return cmd.message;
  }
}
