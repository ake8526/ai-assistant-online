// The nine LINE rich-menu tiles, on their own so a browser page can read them.
//
// They used to live in lib/lineRichMenu.ts, which also draws the menu PNG with
// sharp. Importing that module from a client component dragged sharp — and its
// `require("child_process")` — into the browser bundle and the build failed with
// "Module not found: Can't resolve 'child_process'". The data has no such
// dependency, so it sits here and lineRichMenu.ts re-exports it: one list, two
// consumers, no server-only code crossing into the browser.
//
// Every `text` must be something the assistant already answers — a tile that
// lands on "ไม่เข้าใจครับ" is worse than no tile.

export type IconKind =
  | "cal"
  | "meet"
  | "news"
  | "file"
  | "car"
  | "soon"
  | "gear"
  | "book"
  | "people"
  | "task"
  | "help";

export type MenuTile = {
  col: number;
  row: number;
  label: string;
  text: string;
  bg: string;
  panel: string;
  icon: IconKind;
  title: string;
  sub: string;
};

/**
 * Read left-to-right: the four things people do daily, then the three they ask
 * for by name, then the manual and the settings page.
 */
export const RICH_MENU_TILES: MenuTile[] = [
  { col: 0, row: 0, label: "ตารางจอง", text: "ตาราง·จอง", bg: "#ffffff", panel: "#e0f2f1", icon: "cal", title: "ตาราง·จอง", sub: "ติดตามนัด" },
  { col: 1, row: 0, label: "นัดประชุม", text: "นัดประชุม", bg: "#ffffff", panel: "#e0f2f1", icon: "book", title: "นัดประชุม", sub: "หาเวลาว่างตรงกัน" },
  { col: 2, row: 0, label: "ตารางคนอื่น", text: "👥 ตารางคนอื่น", bg: "#ffffff", panel: "#e0f2f1", icon: "people", title: "ตารางคนอื่น", sub: "ดูว่าใครว่าง" },
  { col: 0, row: 1, label: "สรุปประชุม", text: "สรุปประชุม", bg: "#f8fafc", panel: "#e2e8f0", icon: "meet", title: "สรุปประชุม", sub: "มอบหมายงาน" },
  { col: 1, row: 1, label: "งานที่ต้องตาม", text: "ดูงานที่ต้องติดตาม", bg: "#f8fafc", panel: "#e2e8f0", icon: "task", title: "งานที่ต้องตาม", sub: "เตือนให้เอง" },
  { col: 2, row: 1, label: "สรุปข่าว", text: "ข่าววันนี้", bg: "#f8fafc", panel: "#e2e8f0", icon: "news", title: "สรุปข่าว", sub: "ที่ติดตาม" },
  { col: 0, row: 2, label: "ไฟล์", text: "ไฟล์", bg: "#fff7ed", panel: "#ffedd5", icon: "file", title: "ไฟล์", sub: "ค้น·ผูก·แนบ" },
  { col: 1, row: 2, label: "คู่มือคำสั่ง", text: "/ช่วยเหลือ", bg: "#eef2ff", panel: "#e0e7ff", icon: "help", title: "คู่มือคำสั่ง", sub: "สั่งอะไรได้บ้าง" },
  { col: 2, row: 2, label: "ตั้งค่า", text: "ตั้งค่า", bg: "#ecfdf5", panel: "#ccfbf1", icon: "gear", title: "ตั้งค่า", sub: "เปิดหน้าเว็บ" },
];
