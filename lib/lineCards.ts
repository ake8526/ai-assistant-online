/**
 * The one Flex card shape this bot uses for "pick one of these".
 *
 * A quick reply can only show 20 characters and LINE scrolls the strip
 * sideways, so a list of ten people or eight time slots showed three and hid
 * the rest behind a swipe. A Flex row shows the whole line and takes the tap
 * itself. The help menu was the first place this worked (lib/help.ts); the
 * shape lives here so the person picker and the time picker look the same.
 *
 * Two kinds of row:
 *   messageRow  — the tap sends text, exactly as if the user typed it
 *   postbackRow — the tap sends postback data, for a choice that carries an id
 *                 (a mail address, an event id, a slot's start/end)
 */

const ROW_ARROW = {
  type: "text",
  text: "›",
  size: "lg",
  color: "#9aa3b2",
  flex: 0,
  align: "end",
} as const;

const HEADER_GREEN = "#06c755";

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function row(display: string, action: object, sub?: string): object {
  const label: object[] = [
    { type: "text", text: display, size: "sm", color: "#111111", weight: "bold", wrap: true },
  ];
  if (sub) label.push({ type: "text", text: sub, size: "xxs", color: "#8b93a3", wrap: true, margin: "xs" });
  return {
    type: "box",
    layout: "horizontal",
    spacing: "sm",
    paddingAll: "10px",
    backgroundColor: "#f4f6f8",
    cornerRadius: "8px",
    margin: "sm",
    action,
    contents: [{ type: "box", layout: "vertical", flex: 1, contents: label }, ROW_ARROW],
  };
}

/** Tap sends `send` as a message — same effect as typing it. */
export function messageRow(display: string, send: string, sub?: string): object {
  return row(display, { type: "message", label: truncate(display, 20), text: send.slice(0, 300) }, sub);
}

/**
 * Tap sends postback `data`. `displayText` is what the user's own bubble shows,
 * so it has to name the choice being made — never a bare "ยืนยัน", or the chat
 * log stops saying which question was answered. Returns null when the payload
 * is over LINE's 300-character limit (it would fail silently at send).
 */
export function postbackRow(
  display: string,
  data: string,
  displayText: string,
  sub?: string
): object | null {
  if (!data || data.length > 300) return null;
  return row(
    display,
    { type: "postback", label: truncate(display, 20), data, displayText: truncate(displayText, 60) },
    sub
  );
}

/** Tap opens a web page — the settings page, a map, a summary link. */
export function uriRow(display: string, url: string, sub?: string): object | null {
  if (!url) return null;
  return row(display, { type: "uri", label: truncate(display, 20), uri: url }, sub);
}

/** A small grey footnote under the rows (the “💡 …” line). */
export function noteRow(text: string): object {
  return { type: "text", text: `💡 ${text}`, size: "xxs", color: "#69707d", wrap: true, margin: "lg" };
}

/** Green header + rows, the look every card in this bot shares. */
export function card(title: string, subtitle: string, rows: object[]): object {
  return {
    type: "bubble",
    size: "mega",
    header: {
      type: "box",
      layout: "vertical",
      backgroundColor: HEADER_GREEN,
      paddingAll: "14px",
      contents: [
        { type: "text", text: title, color: "#ffffff", weight: "bold", size: "md", wrap: true },
        { type: "text", text: subtitle, color: "#e6fff0", size: "xs", wrap: true, margin: "xs" },
      ],
    },
    body: { type: "box", layout: "vertical", paddingAll: "12px", contents: rows },
  };
}

/** card() plus the altText LINE shows in the chat list / notifications. */
export function pickerCard(
  title: string,
  subtitle: string,
  rows: object[],
  altText?: string
): { altText: string; contents: object } {
  return { altText: (altText || title).slice(0, 400), contents: card(title, subtitle, rows) };
}
