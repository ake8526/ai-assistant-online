"use client";

/**
 * เมนูคำสั่ง — พิมพ์ "/" ในช่องแชทแล้วรายการคำสั่งเด้งขึ้นมาให้เลือกเลย
 *
 * ของเดิมต้องพิมพ์ "/" แล้วกดส่งก่อน ผู้ช่วยถึงตอบกลับมาเป็นรายการปุ่ม —
 * เสียหนึ่งรอบ และรายการค้างอยู่ในประวัติแชท เมนูนี้ขึ้นระหว่างพิมพ์
 * ไม่ต้องส่ง ไม่ทิ้งอะไรไว้ในแชท และกรองได้ทันที
 *
 * รายการมาจาก SLASH_COMMANDS ที่เดียวกับปุ่มใน LINE — เพิ่มคำสั่งในไฟล์นั้น
 * ไฟล์เดียว เมนูนี้ขึ้นตามเอง (คำสั่งที่ยังไม่ได้จับคู่ไอคอนใช้ไอคอนสำรอง)
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  CalendarClock,
  CalendarDays,
  CircleHelp,
  Eraser,
  Newspaper,
  Sun,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import { SLASH_COMMANDS, type SlashCommand } from "@/lib/slashCommands";
import { INK_2, N_BLUE, N_GREEN, N_ORANGE, N_PINK, N_PURPLE, N_YELLOW, NOTE } from "@/components/noteStyles";

const LOOK: Record<string, { icon: LucideIcon; tint: string }> = {
  ล้างความจำ: { icon: Eraser, tint: N_PINK },
  ยกเลิก: { icon: X, tint: N_ORANGE },
  ตารางวันนี้: { icon: CalendarDays, tint: N_BLUE },
  นัดพรุ่งนี้: { icon: CalendarClock, tint: N_BLUE },
  ตั้งค่าข่าว: { icon: Newspaper, tint: N_PURPLE },
  ช่วยเหลือ: { icon: CircleHelp, tint: N_GREEN },
  test: { icon: Sun, tint: N_YELLOW },
  test_meeting: { icon: Users, tint: N_YELLOW },
};

const FALLBACK = { icon: CircleHelp, tint: N_YELLOW };

/** ข้อความในช่องกำลังเป็นคำสั่งอยู่ไหม — "" คือเพิ่งกด / เฉย ๆ, null คือไม่ใช่คำสั่ง */
export function slashQuery(text: string): string | null {
  const first = text[0];
  if (first !== "/" && first !== "／") return null;
  return text.slice(1);
}

function headWord(q: string): string {
  return (q.trim().split(/\s+/)[0] || "").toLowerCase();
}

/**
 * กรองตามชื่อคำสั่ง ชื่อเล่น และคำอธิบาย — /help ต้องเจอ /ช่วยเหลือ
 *
 * `cmds` คือชุดที่ผู้ใช้คนนั้นเห็นได้ (บางคำสั่งจำกัดสิทธิ์) — ไม่ใช่ทั้งหมดเสมอไป
 *
 * ชื่อคำสั่งต้องมาก่อนคำอธิบายเสมอ ไม่ใช่เรียงตามลำดับในไฟล์: พิมพ์ "/ยกเลิก"
 * แล้วได้ /ล้างความจำ ขึ้นก่อน (เพราะคำอธิบายของมันมีคำว่า "ยกเลิกงานค้าง")
 * แปลว่ากด Enter ทันทีจะไปล้างประวัติแชททิ้ง ทั้งที่พิมพ์ชื่อคำสั่งมาตรง ๆ แล้ว
 */
export function filterCommands(q: string, cmds: SlashCommand[] = SLASH_COMMANDS): SlashCommand[] {
  const h = headWord(q);
  if (!h) return cmds;
  const names = (c: SlashCommand) => [c.cmd, ...(c.aliases || [])].map((s) => s.toLowerCase());
  const rank = (c: SlashCommand) => {
    const ns = names(c);
    if (ns.some((n) => n === h)) return 0;
    if (ns.some((n) => n.startsWith(h))) return 1;
    if (ns.some((n) => n.includes(h))) return 2;
    if (c.hint.toLowerCase().includes(h)) return 3;
    return 9;
  };
  return cmds.map((c, i) => ({ c, i, r: rank(c) }))
    .filter((x) => x.r < 9)
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.c);
}

export function useSlashMenu({
  commands,
  input,
  setInput,
  send,
  focusInput,
}: {
  /** คำสั่งที่ผู้ใช้คนนี้เห็นได้ — คนนอกกลุ่มทดสอบต้องไม่เจอ /test ทั้งในเมนูและตอนพิมพ์เอง */
  commands: SlashCommand[];
  input: string;
  setInput: (v: string) => void;
  /** ส่งข้อความ — ตัวเดียวกับปุ่มส่ง */
  send: (text?: string) => void;
  focusInput: () => void;
}) {
  const q = slashQuery(input);
  const items = useMemo(() => (q === null ? [] : filterCommands(q, commands)), [q, commands]);
  /**
   * แถวที่เลือกอยู่ ผูกกับข้อความที่ค้นตอนนั้น — พิมพ์ต่อจนรายการเปลี่ยน
   * ตัวเลือกกลับไปแถวแรกเอง ไม่ค้างอยู่ที่ตำแหน่งของรายการชุดเก่า
   */
  const [sel, setSel] = useState<{ q: string; i: number }>({ q: "", i: 0 });
  const qKey = q ?? "";
  const index = sel.q === qKey && sel.i < items.length ? sel.i : 0;
  const setIndex = (i: number) => setSel({ q: qKey, i });
  /**
   * ข้อความในช่อง ณ ตอนที่ผู้ใช้ปิดเมนู (esc / คลิกที่อื่น) — เทียบแบบตรงตัว
   * ไม่ใช่ขึ้นต้นด้วย เพราะ "ปิดตอนพิมพ์ /" ไม่ควรแปลว่าปิดยาวทั้งข้อความ
   * และค้างข้ามรอบไม่ได้ พอพิมพ์ต่างจากเดิมเมื่อไหร่เมนูก็กลับมาเอง
   */
  const [closedAt, setClosedAt] = useState<string | null>(null);
  // ออกจากโหมดคำสั่งแล้ว (ลบ / ทิ้ง หรือส่งไปแล้ว) การปิดครั้งก่อนหมดอายุ —
  // ไม่งั้นพิมพ์ "/" อีกครั้งด้วยข้อความเดิมเป๊ะ เมนูจะไม่ยอมเปิดให้
  const [seen, setSeen] = useState(input);
  if (input !== seen) {
    setSeen(input);
    if (slashQuery(input) === null && closedAt !== null) setClosedAt(null);
  }

  /**
   * พิมพ์ชื่อคำสั่งที่ต้องมีส่วนขยายครบแล้วเว้นวรรค = กำลังพิมพ์ส่วนขยายอยู่
   * (เช่น "/test_meeting ประชุมงบ") เมนูต้องหลบให้ ไม่ต้องจำสถานะอะไรไว้
   */
  const typingArg = (() => {
    if (q === null) return false;
    const m = /^(\S+)\s/.exec(q);
    if (!m) return false;
    const head = m[1].toLowerCase();
    return commands.some(
      (c) => !!c.arg && [c.cmd, ...(c.aliases || [])].some((n) => n.toLowerCase() === head)
    );
  })();

  const open = q !== null && !typingArg && input !== closedAt;

  const close = () => setClosedAt(input);

  /** ปุ่ม / ข้างช่องพิมพ์ — บนมือถือกด / บนคีย์บอร์ดลำบาก */
  const toggle = () => {
    if (open) {
      close();
      return;
    }
    setClosedAt(null);
    // ยังไม่ได้ขึ้นต้นด้วย / ก็เติมให้ — เติมนำหน้า ไม่ใช่ล้าง สิ่งที่พิมพ์ไว้จึงไม่หาย
    if (q === null) setInput(input.trim() ? `/${input.trim()}` : "/");
    focusInput();
  };

  const pick = (c: SlashCommand) => {
    // คำสั่งที่ต้องพิมพ์ต่อ (เช่นชื่อเรื่องประชุม) เติมคำสั่งให้แล้วรอ — ไม่ส่งทันที
    // เว้นวรรคท้ายทำให้ typingArg เป็นจริง เมนูจึงหลบไปเองโดยไม่ต้องสั่งปิด
    if (c.arg) {
      setInput(`/${c.cmd} `);
      focusInput();
      return;
    }
    setInput("");
    setClosedAt(null);
    send(`/${c.cmd}`);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // ระหว่างสะกดคำด้วย IME ปุ่ม Enter เป็นของ IME ไม่ใช่ของเรา
    if ((e.nativeEvent as unknown as { isComposing?: boolean }).isComposing) return;
    if (open && items.length) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setIndex((index + 1) % items.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setIndex((index - 1 + items.length) % items.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pick(items[index] || items[0]);
        return;
      }
    }
    if (e.key === "Escape") {
      if (open) {
        e.preventDefault();
        close();
      }
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return { open, items, index, setIndex, query: q ?? "", pick, close, toggle, onKeyDown };
}

/** ไฮไลต์ส่วนที่ตรงกับที่พิมพ์ */
function Marked({ text, q }: { text: string; q: string }) {
  const i = q ? text.toLowerCase().indexOf(q) : -1;
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <mark className="bg-[var(--nb-orange)] text-inherit rounded-[3px] px-px">{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  );
}

export function SlashMenu({
  items,
  index,
  query,
  onPick,
  onHover,
}: {
  items: SlashCommand[];
  index: number;
  query: string;
  onPick: (c: SlashCommand) => void;
  onHover: (i: number) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listRef.current?.querySelector(`[data-i="${index}"]`)?.scrollIntoView({ block: "nearest" });
  }, [index]);

  const h = headWord(query);

  return (
    <div
      role="listbox"
      aria-label="คำสั่ง"
      className={`${NOTE} absolute left-0 right-0 bottom-full mb-2 z-20 overflow-hidden bg-[var(--nb-surface)]`}
    >
      <div
        className={`${INK_2} flex items-baseline gap-2 px-3 pt-1.5 pb-1 border-b-2 border-dashed border-[var(--nb-dash)] font-hand text-[15px]`}
      >
        <b className="font-marker font-normal text-[12.5px] text-[var(--nb-ink)]">คำสั่งทั้งหมด</b>
        {items.length > 0 && <span>{items.length} คำสั่ง</span>}
        <span className="ml-auto hidden sm:inline">↑↓ เลือก · ↵ ใช้ · esc ปิด</span>
      </div>

      {items.length === 0 ? (
        <div className={`${INK_2} px-3 py-3 text-center font-hand text-[16px]`}>
          ไม่มีคำสั่งชื่อนี้ — พิมพ์สั่งเป็นภาษาคนได้เลยครับ
        </div>
      ) : (
        <div ref={listRef} className="max-h-[min(244px,45vh)] overflow-y-auto">
          {items.map((c, i) => {
            const look = LOOK[c.cmd] || FALLBACK;
            const Icon = look.icon;
            const on = i === index;
            return (
              <button
                key={c.cmd}
                type="button"
                data-i={i}
                role="option"
                aria-selected={on}
                // ปล่อยให้ช่องพิมพ์ยังโฟกัสอยู่ ไม่งั้น blur ปิดเมนูก่อนคลิกจะทำงาน
                onMouseDown={(e) => e.preventDefault()}
                onMouseMove={() => onHover(i)}
                onClick={() => onPick(c)}
                className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-left border-b border-dashed border-[var(--nb-dash)] last:border-b-0 cursor-pointer ${
                  on ? "bg-[var(--nb-yellow)]" : ""
                }`}
              >
                <span
                  className={`${look.tint} shrink-0 w-[30px] h-[30px] border-2 border-[var(--nb-ink)] rounded-[9px] grid place-items-center`}
                >
                  <Icon className="w-[15px] h-[15px]" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-1.5 flex-wrap text-[13.5px]">
                    /<Marked text={c.cmd} q={h} />
                    {c.arg && (
                      <em className={`${INK_2} not-italic font-hand text-[14px] border border-[var(--nb-dash)] rounded-[6px] px-1.5`}>
                        {c.arg}
                      </em>
                    )}
                  </span>
                  <span className={`${INK_2} block text-[11.5px] leading-[1.35]`}>{c.hint}</span>
                </span>
                <span className={`${INK_2} font-hand text-[15px] ${on ? "" : "opacity-0"}`}>
                  {c.arg ? "tab" : "↵"}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
