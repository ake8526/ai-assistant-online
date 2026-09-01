/** chip บริบทตามแท็บ — แสดงใน Assistant sheet ก่อนส่งข้อความ (P1) */

export type SheetTab = "sched" | "task" | "set";

export type ContextChip = { label: string; text: string };

const BY_TAB: Record<SheetTab, ContextChip[]> = {
  sched: [
    { label: "ตารางวันนี้", text: "ตารางวันนี้" },
    { label: "หาเวลาว่าง", text: "ดูตารางว่าง" },
    { label: "นัดประชุม", text: "นัดประชุม" },
  ],
  task: [
    { label: "งานค้าง", text: "งานค้างมีอะไรบ้าง" },
    { label: "เพิ่มงาน", text: "เพิ่มงาน" },
  ],
  set: [
    { label: "/ช่วยเหลือ", text: "/ช่วยเหลือ" },
    { label: "/ตั้งค่าข่าว", text: "/ตั้งค่าข่าว" },
  ],
};

export function contextChipsForTab(tab: SheetTab): ContextChip[] {
  return BY_TAB[tab] ?? [];
}
