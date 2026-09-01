"use client";

/**
 * เข้าใช้ครั้งแรก — ตั้งค่าก่อน แล้วพาเดินดูทุกเมนู
 *
 * คนที่เพิ่งได้บัญชีมา ล็อกอินเข้ามาเจอหน้าแชทเปล่า ๆ ถามอะไรไปก็ได้แต่
 * "ไม่พบข้อมูล" เพราะยังไม่ได้อนุญาตให้อ่านปฏิทิน — ดูเหมือนแอปพัง ทั้งที่แค่ยัง
 * ไม่ได้กดอนุญาต หน้าตั้งค่าครั้งแรกจึงมาก่อนหน้าแชท แล้วต่อด้วยทัวร์ชี้ทีละจุด
 *
 * ข้ามได้สองระดับ: "ข้ามเมนูนี้" กระโดดไปเมนูถัดไป, "ข้ามการสอน" ออกทั้งหมด
 * ทั้งสองอย่างกลับมาเล่นใหม่ได้ที่ ตั้งค่า → เรียนรู้การใช้งาน
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Check } from "lucide-react";
import { INK_2, INK_3, N_BLUE, N_GREEN, N_PINK, N_YELLOW, NOTE, NOTE_SM, PRESS } from "@/components/noteStyles";

export type TabKey = "chat" | "sched" | "task" | "set";

/* ── ทัวร์ ──────────────────────────────────────────────────────────────── */

type Step = {
  /** ค่าใน data-tour ของสิ่งที่จะส่องไฟ — ไม่มีในจอตอนนั้นก็ข้ามไปเอง */
  sel: string;
  tab: TabKey;
  menu: string;
  title: string;
  body: string;
  /** หัวข้อของกล่องตัวอย่าง เช่น "ตัวอย่าง" / "ใช้ตอนไหน" */
  lbl: string;
  said: string;
  got: string;
};

/** ทุกเมนูเริ่มด้วยการชี้ปุ่มแท็บก่อนว่าอยู่ตรงไหน แล้วค่อยพาดูข้างใน */
export const TOUR: Step[] = [
  {
    sel: "tab-chat", tab: "chat", menu: "ผู้ช่วย AI",
    title: "แท็บผู้ช่วย AI — ที่สั่งงาน",
    body: "แท็บแรกคือที่คุยกับผู้ช่วย สั่งงาน ถามตาราง จองห้อง ตามงานค้าง ทำได้จากที่นี่ที่เดียว",
    lbl: "จำง่าย ๆ", said: "ไอคอนกล่องข้อความ ซ้ายสุดของแถบล่าง",
    got: "แท็บที่เปิดอยู่จะเป็นกรอบสีมีเงา",
  },
  {
    sel: "chat-input", tab: "chat", menu: "ผู้ช่วย AI",
    title: "พิมพ์สั่งเป็นภาษาคนได้เลย",
    body: "ไม่ต้องจำรูปแบบคำสั่ง พิมพ์อย่างที่พูดได้เลย ผู้ช่วยจะไปดูปฏิทินของทุกคนที่เกี่ยวข้องให้เอง แล้วเสนอเฉพาะช่วงที่ว่างตรงกันจริง",
    lbl: "ตัวอย่างที่ใช้ได้", said: "คุณพิมพ์ · «ขอห้องประชุมกับพี่สมชายบ่ายพรุ่งนี้ 1 ชั่วโมง»",
    got: "ผู้ช่วยตอบ · เจอ 2 ช่วงที่ว่างตรงกัน แล้วให้กดเลือกช่วง",
  },
  {
    sel: "chat-ask", tab: "chat", menu: "ผู้ช่วย AI",
    title: "ไม่รู้จะสั่งอะไร กดปุ่มนี้",
    body: "ปุ่ม ? เปิดรายการคำสั่งทั้งหมดขึ้นมาให้เลือก พิมพ์เครื่องหมาย / ในช่องข้อความก็ได้ผลเหมือนกัน พิมพ์ต่ออีกนิดจะกรองให้เอง",
    lbl: "ตัวอย่าง", said: "กด ? แล้วพิมพ์ต่อว่า «ตาราง»",
    got: "เหลือคำสั่งเดียว · /ตารางวันนี้ — กดใช้ได้ทันที",
  },
  {
    sel: "chat-chips", tab: "chat", menu: "ผู้ช่วย AI",
    title: "ปุ่มลัด — เรียงตามที่คุณใช้บ่อย",
    body: "แถวนี้ไม่ตายตัว คำสั่งที่คุณกดบ่อยจะเลื่อนขึ้นมาอยู่ต้นแถวเอง ไม่ต้องตั้งค่าอะไร ของแต่ละคนจึงไม่เหมือนกัน",
    lbl: "ตัวอย่าง", said: "ใช้ /ตารางวันนี้ ทุกเช้าติดกัน 3 วัน",
    got: "วันที่ 4 ปุ่มนี้ขึ้นมาเป็นปุ่มแรกของแถวเอง",
  },
  {
    sel: "chat-clear", tab: "chat", menu: "ผู้ช่วย AI",
    title: "ปุ่มล้าง — เริ่มเรื่องใหม่",
    body: "ผู้ช่วยจำเรื่องที่คุยค้างไว้ เพื่อให้ถามต่อสั้น ๆ ได้ พอเปลี่ยนเรื่องแล้วมันยังตอบเรื่องเก่า ให้กดล้างเริ่มใหม่",
    lbl: "ตัวอย่าง", said: "คุยเรื่องจองห้องค้างไว้ แล้วพิมพ์ว่า «พรุ่งนี้ว่างไหม»",
    got: "ถ้าไม่ล้าง · ผู้ช่วยจะคิดว่ายังถามเรื่องห้องประชุมอยู่",
  },

  {
    sel: "tab-sched", tab: "sched", menu: "ตาราง",
    title: "แท็บตาราง — นัดและห้องประชุม",
    body: "แท็บที่สองรวมนัดทั้งหมดกับสถานะห้องประชุมไว้ที่เดียว ใช้ตอนอยากเห็นภาพรวมเอง ไม่ต้องพิมพ์ถาม",
    lbl: "ใช้ตอนไหน", said: "อยากรู้ว่าสัปดาห์นี้แน่นแค่ไหน",
    got: "กดแท็บนี้ · เห็นทั้งสัปดาห์ในหน้าเดียว",
  },
  {
    sel: "sched-view", tab: "sched", menu: "ตาราง",
    title: "สลับ 7 วัน กับ ทั้งเดือน",
    body: "«7 วัน» ดูสัปดาห์นี้แบบละเอียด «เดือน» ไว้หาวันว่างสำหรับนัดที่ยังไม่รีบ",
    lbl: "ตัวอย่าง", said: "หัวหน้าถามว่า «สิ้นเดือนว่างวันไหนบ้าง»",
    got: "กด «เดือน» แล้วดูวันที่ไม่มีจุด = วันที่ยังว่าง",
  },
  {
    sel: "sched-days", tab: "sched", menu: "ตาราง",
    title: "แถบวัน — จุดใต้ตัวเลขคือมีนัด",
    body: "วันที่มีนัดจะมีจุดอยู่ใต้ตัวเลข แตะวันไหนก็เลื่อนไปดูนัดของวันนั้น",
    lbl: "อ่านยังไง", said: "วันไหนไม่มีจุด",
    got: "วันนั้นว่างทั้งวัน — นัดใครก็ได้ไม่ชนของเดิม",
  },
  {
    sel: "sched-events", tab: "sched", menu: "ตาราง",
    title: "การ์ดนัด + ปุ่มเข้าประชุม",
    body: "แต่ละนัดบอกเวลา สถานที่ และจำนวนคน ปุ่มเข้าประชุมเปิดแอป Teams ให้เลย (ต้องเป็นแอปรุ่น 3.4 ขึ้นไป รุ่นเก่าจะคัดลอกลิงก์ให้แทน)",
    lbl: "ตัวอย่าง", said: "ถึงเวลาประชุม กดปุ่ม «เข้าประชุม»",
    got: "Teams เปิดที่ห้องนั้นเลย ไม่ต้องไปหาลิงก์ในเมล",
  },
  {
    sel: "sched-rooms", tab: "sched", menu: "ตาราง",
    title: "สถานะห้องประชุมตอนนี้",
    body: "ดูได้ทันทีว่าห้องไหนว่าง ไม่ว่าง หรือว่างตลอดทั้งวัน โดยไม่ต้องเดินไปดูหน้าห้อง",
    lbl: "ตัวอย่าง", said: "เห็นว่าห้อง 3A ไม่ว่างถึงบ่ายสอง",
    got: "สั่งผู้ช่วยว่า «จองห้อง 2B บ่ายสาม 1 ชั่วโมง» ได้เลย",
  },

  {
    sel: "tab-task", tab: "task", menu: "งาน",
    title: "แท็บงาน — งานค้างทั้งหมด",
    body: "แท็บที่สามคืองานค้างที่ดึงมาจาก Microsoft To Do ปิดงานได้จากตรงนี้เลย ไม่ต้องสลับไปอีกแอป",
    lbl: "ใช้ตอนไหน", said: "เช้ามาอยากรู้ว่าค้างอะไรบ้าง",
    got: "กดแท็บนี้ · งานที่เลยกำหนดจะอยู่บนสุด",
  },
  {
    sel: "task-list", tab: "task", menu: "งาน",
    title: "ป้ายบอกกำหนดส่ง",
    body: "งานทั้งหมดมาจาก To Do ของคุณเอง ไม่ต้องพิมพ์ซ้ำ ป้ายด้านขวาบอกกำหนดส่ง — เลยกำหนดแล้วจะเด่นที่สุดและอยู่บนสุด",
    lbl: "อ่านป้ายยังไง", said: "ป้าย «เกิน»",
    got: "งานนั้นเลยกำหนดมาแล้ว ควรจัดการก่อนเพื่อน",
  },
  {
    sel: "task-list", tab: "task", menu: "งาน",
    title: "ปิดงานจากตรงนี้ได้เลย",
    body: "กดปิดงานแล้วจะมีถามยืนยันก่อนหนึ่งครั้ง ปิดแล้วสถานะไปอัปเดตที่ To Do ให้ด้วย และรายการนี้ตามเก็บงานใหม่ให้เองทุกนาที ไม่ต้องกดโหลด",
    lbl: "ตัวอย่าง", said: "กด «ปิดงาน» → ขึ้นปุ่ม «ยืนยันปิดงาน»",
    got: "กดยืนยัน · งานหายจากรายการ และปิดใน To Do ให้ด้วย",
  },

  {
    sel: "tab-set", tab: "set", menu: "ตั้งค่า",
    title: "แท็บตั้งค่า — ปรับทุกอย่าง",
    body: "แท็บสุดท้ายเก็บทุกอย่างที่ปรับได้ เวลาทำงาน สรุปเช้า ข่าว การเชื่อมต่อ ธีม และปุ่มเรียกทัวร์นี้กลับมาเล่นใหม่",
    lbl: "จำแค่นี้พอ", said: "ลืมอะไรก็มาที่แท็บนี้",
    got: "ทุกอย่างที่ตั้งค่าครั้งแรกไว้ แก้ที่นี่ได้หมด",
  },
  {
    sel: "set-cards", tab: "set", menu: "ตั้งค่า",
    title: "6 หมวด แตะการ์ดเพื่อกางดู",
    body: "ทุกอย่างที่ปรับได้แบ่งเป็นการ์ด — บัญชี, เวลาทำงาน, การแจ้งเตือน, หน้าจอ, การเชื่อมต่อ และช่วยเหลือ บรรทัดใต้หัวการ์ดสรุปค่าที่ตั้งไว้ตอนนี้ให้เห็นโดยไม่ต้องกางเข้าไป",
    lbl: "อ่านจากหน้าแรกได้เลย", said: "การ์ด «การแจ้งเตือน» เขียนว่า สรุปงานเช้า: 07:01 · จ–ศ",
    got: "รู้ทันทีว่าตั้งไว้กี่โมง ไม่ต้องกางเข้าไปดู",
  },
  {
    sel: "set-learn", tab: "set", menu: "ตั้งค่า",
    title: "กลับมาเรียนใหม่ได้ตลอด",
    body: "การ์ด «ช่วยเหลือ & ระบบ» เก็บคู่มือคำสั่ง สถานะระบบ และปุ่มเล่นทัวร์นี้ใหม่ แตะเข้าไปแล้วกด «เล่นทัวร์อีกครั้ง» ได้ทุกเมื่อ",
    lbl: "จำแค่นี้พอ", said: "ตั้งค่า → ช่วยเหลือ & ระบบ → เรียนรู้การใช้งาน",
    got: "ทัวร์นี้เล่นใหม่ได้ไม่จำกัด และกลับไปหน้าตั้งค่าครั้งแรกได้จากที่เดียวกัน",
  },
];

const TIP_H = 300;
const TOP_SAFE = 10;
const GAP = 12;

export function TourOverlay({
  onTab,
  onClose,
}: {
  onTab: (t: TabKey) => void;
  onClose: () => void;
}) {
  const [i, setI] = useState(0);
  const [box, setBox] = useState<{ t: number; l: number; w: number; h: number } | null>(null);
  const [tipTop, setTipTop] = useState(TOP_SAFE);
  const tipRef = useRef<HTMLDivElement>(null);

  const step = TOUR[i];
  const menuFirst = TOUR.findIndex((s) => s.menu === step?.menu);
  const menuLen = TOUR.filter((s) => s.menu === step?.menu).length;

  const place = useCallback(() => {
    // แชทมีสองที่ (แท็บกับแผ่นที่เลื่อนขึ้นมา) ป้ายเดียวกันจึงมีได้หลายตัว —
    // เอาตัวที่มองเห็นจริง ไม่ใช่ตัวแรกที่เจอซึ่งอาจถูกซ่อนอยู่
    const el = [...document.querySelectorAll<HTMLElement>(`[data-tour="${TOUR[i].sel}"]`)].find(
      (e) => e.getBoundingClientRect().width > 0
    );
    if (!el) {
      setBox(null);
      return;
    }
    el.scrollIntoView({ block: "nearest", behavior: "auto" });
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    const pad = 6, edge = 4;
    let t = r.top - pad, l = r.left - pad;
    let w = r.width + pad * 2, h = r.height + pad * 2;
    if (t < edge) { h += t - edge; t = edge; }
    if (l < edge) { w += l - edge; l = edge; }
    h = Math.min(h, vh - t - edge);
    w = Math.min(w, vw - l - edge);
    setBox({ t, l, w, h });

    // กล่องคำอธิบายไปอยู่ฝั่งตรงข้ามกับจุดที่ส่องไฟเสมอ จะได้ไม่บังของที่กำลังชี้
    const fitsAbove = t >= TOP_SAFE + TIP_H + GAP;
    const fitsBelow = t + h + GAP + TIP_H + 10 <= vh;
    setTipTop(
      fitsAbove ? TOP_SAFE : fitsBelow ? t + h + GAP : vh - (t + h) >= t ? vh - TIP_H - 10 : TOP_SAFE
    );
  }, [i]);

  /* ฟังก์ชันที่ส่งเข้ามาเป็น arrow ใหม่ทุกครั้งที่หน้าแม่ re-render — ใส่ไว้ใน deps
     ตรง ๆ แล้วเอฟเฟกต์จะวิ่งใหม่ทุกจังหวะ วัดตำแหน่งซ้อนกันจนกล่องไปค้างที่เก่า */
  const cbs = useRef({ onTab, onClose });
  useEffect(() => {
    cbs.current = { onTab, onClose };
  });

  // ข้ามจุดที่ไม่มีอยู่ในจอจริง (ยังไม่มีนัด/ไม่มีงานค้าง) แทนที่จะส่องไฟใส่ที่ว่าง
  useEffect(() => {
    cbs.current.onTab(TOUR[i].tab);
    const id = window.setTimeout(() => {
      place();
      const seen = [...document.querySelectorAll<HTMLElement>(`[data-tour="${TOUR[i].sel}"]`)].some(
        (e) => e.getBoundingClientRect().width > 0
      );
      if (!seen) {
        if (i < TOUR.length - 1) setI(i + 1);
        else cbs.current.onClose();
      }
    }, 180);
    return () => window.clearTimeout(id);
  }, [i, place]);

  useEffect(() => {
    const on = () => place();
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, [place]);

  const next = () => (i < TOUR.length - 1 ? setI(i + 1) : cbs.current.onClose());
  const back = () => setI((n) => Math.max(0, n - 1));
  /** ข้ามเมนูนี้ = ไปหัวเมนูถัดไป ไม่ใช่ออกจากทัวร์ */
  const skipMenu = () => {
    const nextMenu = TOUR.findIndex((s) => s.menu !== step.menu && TOUR.indexOf(s) > i);
    if (nextMenu < 0) onClose();
    else setI(nextMenu);
  };

  if (!step) return null;

  return (
    <div className="fixed inset-0 z-[60]" role="dialog" aria-label="สอนใช้งาน">
      {box && (
        <div
          className="absolute rounded-[12px] border-2 border-[var(--nb-ink)] pointer-events-none transition-all duration-200"
          style={{
            top: box.t,
            left: box.l,
            width: box.w,
            height: box.h,
            boxShadow: "0 0 0 2400px var(--nb-scrim)",
          }}
        />
      )}

      <div
        ref={tipRef}
        className={`${NOTE} absolute left-1/2 -translate-x-1/2 w-[min(340px,calc(100%-20px))] max-h-[300px] flex flex-col overflow-hidden bg-[var(--nb-surface)] px-3 pt-2.5 pb-3 transition-[top] duration-200`}
        style={{ top: tipTop }}
      >
        <span className="absolute left-0 right-0 top-0 h-[5px] bg-[var(--nb-board)] rounded-t-[12px] overflow-hidden">
          <i
            className="block h-full bg-[var(--nb-yellow)] border-r-2 border-[var(--nb-ink)] transition-[width] duration-200"
            style={{ width: `${Math.round(((i + 1) / TOUR.length) * 100)}%` }}
          />
        </span>

        <div className="flex items-center gap-2">
          <span className={`flex-1 min-w-0 font-hand text-[15px] ${INK_2}`}>
            <b className="font-marker font-normal text-[12px] text-[var(--nb-ink)]">{step.menu}</b>{" "}
            {i - menuFirst + 1} จาก {menuLen}
          </span>
          <button
            type="button"
            onClick={onClose}
            className={`${NOTE_SM} ${PRESS} ${N_PINK} shrink-0 px-2 py-0.5 text-[11.5px] cursor-pointer`}
          >
            ข้ามการสอน
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto">
          <h4 className="font-marker text-[14.5px] mt-1 mb-1">{step.title}</h4>
          <p className="text-[12px] leading-[1.5]">{step.body}</p>
          <div className="mt-2 rounded-[11px] border-2 border-dashed border-[var(--nb-dash)] bg-[var(--nb-board)] px-2.5 py-2">
            <span className={`font-hand text-[14px] ${INK_2}`}>{step.lbl}</span>
            <p className="text-[11.5px] mt-0.5">{step.said}</p>
            <p className="text-[11.5px] mt-1.5 pt-1.5 border-t border-dashed border-[var(--nb-dash)]">
              {step.got}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-1.5 mt-2.5">
          <span className="flex gap-1 mr-auto">
            {Array.from({ length: menuLen }, (_, k) => (
              <i
                key={k}
                className={`w-[6px] h-[6px] rounded-full border-[1.5px] border-[var(--nb-ink)] ${
                  k === i - menuFirst ? "bg-[var(--nb-ink)]" : ""
                }`}
              />
            ))}
          </span>
          <button
            type="button"
            onClick={back}
            disabled={i === 0}
            className={`${INK_2} shrink-0 px-2 py-0.5 text-[11.5px] disabled:opacity-40 cursor-pointer`}
          >
            ย้อน
          </button>
          <button
            type="button"
            onClick={skipMenu}
            className={`${NOTE_SM} ${PRESS} shrink-0 bg-[var(--nb-surface)] px-2 py-0.5 text-[11.5px] cursor-pointer`}
          >
            ข้ามเมนูนี้
          </button>
          <button
            type="button"
            onClick={next}
            className={`${NOTE_SM} ${PRESS} ${N_YELLOW} shrink-0 px-2.5 py-0.5 text-[11.5px] font-semibold cursor-pointer`}
          >
            {i === TOUR.length - 1 ? "เริ่มใช้เลย" : "ถัดไป"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── หน้าตั้งค่าครั้งแรก ────────────────────────────────────────────────── */

type ItemState = "todo" | "done" | "skip";

const DAY_LABEL = ["อา", "จ", "อ", "พ", "พฤ", "ศ", "ส"];

/** เลือกวันในสัปดาห์ — 0 = อาทิตย์ ตรงกับที่ lib/notify ใช้ */
function Days({ days, onChange }: { days: number[]; onChange: (d: number[]) => void }) {
  return (
    <div className="flex flex-wrap gap-1 w-full">
      {DAY_LABEL.map((d, i) => (
        <button
          key={i}
          type="button"
          aria-pressed={days.includes(i)}
          onClick={() => onChange(days.includes(i) ? days.filter((x) => x !== i) : [...days, i].sort())}
          className={`${NOTE_SM} ${PRESS} w-9 py-0.5 text-[12px] cursor-pointer ${
            days.includes(i) ? N_GREEN : `bg-[var(--nb-surface)] ${INK_3} shadow-none`
          }`}
        >
          {d}
        </button>
      ))}
    </div>
  );
}

/** การ์ดหนึ่งข้อในหน้าตั้งค่าครั้งแรก */
function SetupCard({
  state,
  n,
  title,
  hint,
  tag,
  tagTint,
  children,
}: {
  state: ItemState;
  n: number;
  title: string;
  hint: string;
  tag: string;
  tagTint: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`${NOTE} ${state === "done" ? N_GREEN : "bg-[var(--nb-surface)]"} px-3 py-2.5`}>
      <div className="flex items-start gap-2.5">
        <span
          className={`shrink-0 w-[26px] h-[26px] grid place-items-center rounded-[8px] border-2 border-[var(--nb-ink)] ${
            state === "done" ? "bg-[var(--nb-surface)]" : "bg-[var(--nb-board)]"
          }`}
        >
          {state === "done" ? <Check className="w-3.5 h-3.5" /> : state === "skip" ? "–" : n}
        </span>
        <span className="flex-1 min-w-0">
          <b className="block text-[13.5px] font-semibold">{title}</b>
          <span className={`block text-[11.5px] leading-[1.4] ${INK_2}`}>{hint}</span>
        </span>
        <span className={`shrink-0 font-hand text-[14px] px-1.5 rounded-[7px] border-[1.5px] border-[var(--nb-ink)] ${tagTint}`}>
          {tag}
        </span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

export function FirstRunSetup({
  msLinked,
  noLicense,
  lineLinked,
  hoursSet,
  workStart,
  workEnd,
  briefOn,
  briefTime,
  briefDays,
  workDays,
  newsOn,
  onSaveHours,
  onSaveBrief,
  onOpenNews,
  onGrant,
  onRevoke,
  onFinish,
}: {
  msLinked: boolean;
  /** บัญชีนี้ไม่มี License 365 (ไม่มีกล่องจดหมาย) — ส่งนัดให้คนอื่นไม่ได้ */
  noLicense: boolean;
  lineLinked: boolean;
  /** เคยตั้งเวลาทำงานเองแล้วหรือยัง — work_start มีค่าเริ่มต้นให้เสมอ ดูจากค่านั้นไม่ได้ */
  hoursSet: boolean;
  workStart: string;
  workEnd: string;
  briefOn: boolean;
  briefTime: string;
  briefDays: number[];
  workDays: number[];
  newsOn: boolean;
  onSaveHours: (start: string, end: string, days: number[]) => void;
  /** enabled=false คือกดยกเลิกทีหลัง ต้องปิดของจริงด้วย ไม่ใช่แค่เอาเครื่องหมายถูกออก */
  onSaveBrief: (time: string, enabled: boolean, days: number[]) => void;
  /** ไปหน้าเลือกหัวข้อข่าว — เลือกเองว่าจะตามเรื่องอะไร ไม่ใช่ยัดให้ */
  onOpenNews: () => void;
  onGrant: () => void;
  /** ถอนสิทธิ์ที่เคยอนุญาตไว้ — กดผิดแล้วต้องเอาคืนได้ */
  onRevoke: () => void;
  /** tour = จบแล้วเล่นทัวร์ต่อ, skip = ข้ามการตั้งค่า (ยังเล่นทัวร์อยู่ดี) */
  onFinish: (how: "done" | "skip") => void;
}) {
  const [hours, setHours] = useState({ s: workStart || "09:00", e: workEnd || "17:00" });
  const [wd, setWd] = useState<number[]>(workDays.length ? workDays : [1, 2, 3, 4, 5]);
  const [bt, setBt] = useState(briefTime || "07:30");
  const [bd, setBd] = useState<number[]>(briefDays.length ? briefDays : [1, 2, 3, 4, 5]);
  /* กด "อนุญาต Microsoft 365" แล้วแอปกระโดดออกไปหน้า Microsoft พอกลับมาหน้านี้
     ถูกสร้างใหม่หมด สิ่งที่ติ๊กไว้ก่อนหน้าหายเกลี้ยง — เก็บไว้ใน sessionStorage
     ให้กลับมาเจอของเดิม (อยู่แค่แท็บนี้ ปิดแอปแล้วหายไปเอง) */
  const [state, setState] = useState<Record<string, ItemState>>(() => {
    try {
      const saved = sessionStorage.getItem("ktisx_setup_state");
      if (saved) return JSON.parse(saved) as Record<string, ItemState>;
    } catch {
      /* โหมดส่วนตัวอ่านไม่ได้ ก็เริ่มจากค่าที่เซิร์ฟเวอร์บอก */
    }
    return {
    ms: msLinked ? "done" : "todo",
    hours: hoursSet ? "done" : "todo",
    brief: briefOn ? "done" : "todo",
    news: newsOn ? "done" : "todo",
      line: lineLinked ? "done" : "todo",
    };
  });

  useEffect(() => {
    try {
      sessionStorage.setItem("ktisx_setup_state", JSON.stringify(state));
    } catch {
      /* เก็บไม่ได้ก็แค่เริ่มใหม่ตอนกลับมา */
    }
  }, [state]);

  const [busy, setBusy] = useState("");
  const set = (k: string, v: ItemState) => setState((p) => ({ ...p, [k]: v }));
  /**
   * ขอ token กับ MSAL กินเวลาในจังหวะเดียวกับที่กดปุ่ม เครื่องหมายถูกเลยไม่ทันขึ้น
   * — ดูเหมือนกดแล้วไม่ติด ต้องรอแป๊บถึงจะมา ให้จอวาดเสร็จก่อนแล้วค่อยยิงงานหนัก
   */
  const after = (fn: () => void) => window.setTimeout(fn, 0);
  const items = ["ms", "hours", "brief", "news", "line"];
  const doneCount = items.filter((k) => state[k] === "done").length;
  const ready = state.ms === "done" && state.hours === "done";

  /* ค่าที่ตั้งไว้เดิมอาจไม่ตรงกับตัวเลือกที่เตรียมไว้ (เช่นสรุปเช้า 07:01 จาก
     ของเดิม) ถ้าไม่ใส่เข้าไปในรายการ ช่องจะโชว์ตัวแรกทั้งที่ค่าจริงเป็นอีกอัน */
  const withCurrent = (list: string[], v: string) =>
    !v || list.includes(v) ? list : [...list, v].sort();
  const CLOCK = withCurrent(["07:00", "07:30", "08:00", "08:30", "09:00", "09:30", "10:00"], workStart);
  const OUT = withCurrent(["16:00", "16:30", "17:00", "17:30", "18:00"], workEnd);
  const BRIEF = withCurrent(["07:00", "07:30", "08:00", "08:30"], briefTime);

  const field =
    "font-note text-[12.5px] bg-[var(--nb-board)] text-[var(--nb-ink)] border-2 border-[var(--nb-ink)] rounded-[10px] px-2 py-1";

  return (
    <div className="fixed inset-0 z-[55] flex flex-col bg-[var(--nb-board)]">
      <div className="shrink-0 px-4 pt-4 pb-2.5 border-b-2 border-[var(--nb-ink)] bg-[var(--nb-surface)]">
        <h2 className="font-marker text-[17px]">ตั้งค่าก่อนเริ่มใช้</h2>
        <p className={`text-[12.5px] ${INK_2} mt-0.5 mb-2`}>
          ทำครั้งเดียว แล้วผู้ช่วยจะทำงานให้ถูกตั้งแต่วันแรก
        </p>
        <div className="flex items-center gap-2">
          <span className="flex-1 h-3 rounded-full border-2 border-[var(--nb-ink)] bg-[var(--nb-board)] overflow-hidden">
            <i
              className="block h-full bg-[var(--nb-green)] border-r-2 border-[var(--nb-ink)] transition-[width] duration-300"
              style={{ width: `${(doneCount / items.length) * 100}%` }}
            />
          </span>
          <span className={`font-hand text-[16px] ${INK_2}`}>
            {doneCount}/{items.length}
          </span>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-2.5 max-w-md w-full mx-auto">
        <SetupCard
          state={state.ms}
          n={1}
          title="อนุญาตให้อ่านปฏิทินและงาน"
          hint="ไม่อนุญาต ผู้ช่วยจะตอบเรื่องนัดหรืองานค้างไม่ได้เลย"
          tag="จำเป็น"
          tagTint={N_PINK}
        >
          {noLicense && (
            <p className={`${NOTE_SM} ${N_PINK} w-full px-2.5 py-1.5 text-[11.5px] leading-[1.45]`}>
              บัญชีนี้ยังไม่มี License Microsoft 365 — ใช้ Outlook ไม่ได้ และระบบจะ
              <b className="font-semibold"> ส่งนัดให้คนอื่นไม่ได้</b> กรุณาขอ License จากฝ่าย IT ก่อน
            </p>
          )}
          {state.ms === "done" ? (
            <>
              <span className={`font-hand text-[15px] ${INK_2}`}>อนุญาตแล้ว — ดึงปฏิทินได้</span>
              {/* กดอนุญาตไปแล้วต้องถอนคืนได้ ไม่ใช่ให้ไปหาที่หน้าตั้งค่าเอง */}
              <button
                type="button"
                onClick={() => {
                  set("ms", "todo");
                  after(onRevoke);
                }}
                className={`${INK_3} px-1.5 py-1 text-[12.5px] underline cursor-pointer`}
              >
                ยกเลิกการอนุญาต
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => {
                  setBusy("ms");
                  after(onGrant);
                }}
                disabled={busy === "ms"}
                className={`${NOTE_SM} ${PRESS} ${N_BLUE} px-2.5 py-1 text-[12.5px] disabled:opacity-60 cursor-pointer`}
              >
                {busy === "ms" ? "กำลังเปิดหน้าอนุญาต…" : "อนุญาต Microsoft 365"}
              </button>
              {/* กดผิดแล้วต้องถอยได้ ไม่ใช่ค้างอยู่กับ "กำลังเปิด…" จนกว่าจะเปลี่ยนหน้า */}
              {busy === "ms" && (
                <button type="button" onClick={() => setBusy("")} className={`${INK_3} px-1.5 py-1 text-[12.5px] underline cursor-pointer`}>
                  ยกเลิก
                </button>
              )}
            </>
          )}
        </SetupCard>

        <SetupCard
          state={state.hours}
          n={2}
          title="เวลาทำงานของคุณ"
          hint="ใช้หาเวลาว่างและกันไม่ให้จองนัดนอกเวลา"
          tag="จำเป็น"
          tagTint={N_PINK}
        >
          <select className={field} value={hours.s} onChange={(e) => setHours((h) => ({ ...h, s: e.target.value }))}>
            {CLOCK.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
          <span className="text-[12.5px]">ถึง</span>
          <select className={field} value={hours.e} onChange={(e) => setHours((h) => ({ ...h, e: e.target.value }))}>
            {OUT.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => {
              set("hours", "done");
              after(() => onSaveHours(hours.s, hours.e, wd));
            }}
            className={`${NOTE_SM} ${PRESS} ${N_GREEN} px-2.5 py-1 text-[12.5px] cursor-pointer`}
          >
            {state.hours === "done" ? "บันทึกแล้ว" : "ใช้เวลานี้"}
          </button>
          <p className={`w-full text-[11.5px] ${INK_2} mt-0.5`}>ทำงานวันไหนบ้าง</p>
          <Days days={wd} onChange={setWd} />
          {state.hours === "done" && (
            <button type="button" onClick={() => set("hours", "todo")} className={`${INK_3} px-1.5 py-1 text-[12.5px] underline cursor-pointer`}>
              แก้ใหม่
            </button>
          )}
        </SetupCard>

        <SetupCard
          state={state.brief}
          n={3}
          title="สรุปงานเช้า"
          hint="ทุกเช้าวันทำงาน ส่งนัดวันนี้กับงานที่ถึงกำหนดให้"
          tag="แนะนำ"
          tagTint={N_YELLOW}
        >
          <select className={field} value={bt} onChange={(e) => setBt(e.target.value)}>
            {BRIEF.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
          <span className="text-[12.5px]">น.</span>
          <button
            type="button"
            onClick={() => {
              set("brief", "done");
              after(() => onSaveBrief(bt, true, bd));
            }}
            className={`${NOTE_SM} ${PRESS} ${N_GREEN} px-2.5 py-1 text-[12.5px] cursor-pointer`}
          >
            {state.brief === "done" ? "เปิดแล้ว" : "เปิดใช้"}
          </button>
          {state.brief === "todo" ? (
            <button type="button" onClick={() => set("brief", "skip")} className={`${INK_3} px-1.5 py-1 text-[12.5px] cursor-pointer`}>
              ไม่เอา
            </button>
          ) : (
            <button
              type="button"
              onClick={() => {
                const wasOn = state.brief === "done";
                set("brief", "todo");
                if (wasOn) after(() => onSaveBrief(bt, false, bd));
              }}
              className={`${INK_3} px-1.5 py-1 text-[12.5px] underline cursor-pointer`}
            >
              ยกเลิก
            </button>
          )}
          <p className={`w-full text-[11.5px] ${INK_2} mt-0.5`}>ส่งวันไหนบ้าง</p>
          <Days days={bd} onChange={setBd} />
        </SetupCard>

        <SetupCard
          state={state.news}
          n={4}
          title="ข่าวที่อยากให้ตามให้"
          hint="เลือกหัวข้อเอง เช่น น้ำตาล พลังงาน ราคาอ้อย แล้วผู้ช่วยสรุปให้ทุกวัน"
          tag="แนะนำ"
          tagTint={N_YELLOW}
        >
          {state.news === "done" ? (
            <>
              <span className={`font-hand text-[15px] ${INK_2}`}>เปิดแล้ว</span>
              <button
                type="button"
                onClick={onOpenNews}
                className={`${NOTE_SM} ${PRESS} bg-[var(--nb-surface)] px-2.5 py-1 text-[12.5px] cursor-pointer`}
              >
                แก้หัวข้อ
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => {
                  set("news", "done");
                  after(onOpenNews);
                }}
                className={`${NOTE_SM} ${PRESS} ${N_GREEN} px-2.5 py-1 text-[12.5px] cursor-pointer`}
              >
                เลือกหัวข้อข่าว
              </button>
              {state.news === "skip" ? (
                <button type="button" onClick={() => set("news", "todo")} className={`${INK_3} px-1.5 py-1 text-[12.5px] underline cursor-pointer`}>
                  ยกเลิก (ข้ามไว้อยู่)
                </button>
              ) : (
                <button type="button" onClick={() => set("news", "skip")} className={`${INK_3} px-1.5 py-1 text-[12.5px] cursor-pointer`}>
                  ไม่เอา
                </button>
              )}
            </>
          )}
        </SetupCard>

        <SetupCard
          state={state.line}
          n={5}
          title="เชื่อม LINE"
          hint="สั่งงานและรับแจ้งเตือนทาง LINE ได้ ไม่ต้องเปิดแอปนี้ค้างไว้"
          tag="ทำทีหลังได้"
          tagTint="bg-[var(--nb-board)]"
        >
          {state.line === "done" ? (
            <span className={`font-hand text-[15px] ${INK_2}`}>เชื่อมแล้ว</span>
          ) : (
            <>
              <Link href="/line-link" className={`${NOTE_SM} ${PRESS} ${N_GREEN} px-2.5 py-1 text-[12.5px]`}>
                เชื่อม LINE
              </Link>
              {state.line === "skip" ? (
                <button type="button" onClick={() => set("line", "todo")} className={`${INK_3} px-1.5 py-1 text-[12.5px] underline cursor-pointer`}>
                  ยกเลิก (ข้ามไว้อยู่)
                </button>
              ) : (
                <button type="button" onClick={() => set("line", "skip")} className={`${INK_3} px-1.5 py-1 text-[12.5px] cursor-pointer`}>
                  ไว้ก่อน
                </button>
              )}
            </>
          )}
        </SetupCard>

        <p className={`font-hand text-[15px] ${INK_2} text-center`}>แก้ทีหลังได้ที่ ตั้งค่า ทุกข้อ</p>
      </div>

      <div className="shrink-0 flex gap-2 px-3 pt-2.5 pb-[max(0.75rem,env(safe-area-inset-bottom))] border-t-2 border-[var(--nb-ink)] bg-[var(--nb-surface)]">
        {/* ข้ามการตั้งค่า ไม่ได้แปลว่าข้ามการสอน — ยังพาเดินดูให้ก่อน */}
        <button type="button" onClick={() => onFinish("skip")} className={`${INK_2} px-3 py-2 text-[13px] cursor-pointer`}>
          ข้ามไปก่อน
        </button>
        <button
          type="button"
          onClick={() => onFinish("done")}
          disabled={!ready}
          className={`${NOTE} ${PRESS} ${N_YELLOW} flex-1 px-4 py-2.5 text-[14px] font-semibold disabled:opacity-45 cursor-pointer`}
        >
          {ready ? "เริ่มใช้งาน" : "ยังไม่ครบ — ทำต่อ"}
        </button>
      </div>
    </div>
  );
}

/** ไม่มี License 365 — บอกทุกแท็บ เพราะส่งนัดไม่ได้ทั้งระบบ ไม่ใช่แค่หน้าตั้งค่า */
export function NoLicenseNag() {
  return (
    <div className={`${NOTE_SM} ${N_PINK} shrink-0 mx-4 mt-3 px-3 py-2`} role="status">
      <p className="text-[12.5px] leading-snug">
        บัญชีนี้ไม่มี License Microsoft 365 — ส่งนัดประชุมให้คนอื่นไม่ได้
        <br />
        <span className={INK_2}>ขอ License จากฝ่าย IT แล้วเข้าใหม่อีกครั้งครับ</span>
      </p>
    </div>
  );
}

/** แถบเตือนคนที่กดข้ามไป ยังตั้งค่าไม่ครบ */
export function SetupNag({ onOpen }: { onOpen: () => void }) {
  return (
    <div className={`${NOTE_SM} ${N_YELLOW} shrink-0 mx-4 mt-3 px-3 py-2 flex items-center gap-2`} role="status">
      <span className="flex-1 min-w-0 text-[12.5px] leading-snug">
        ยังตั้งค่าไม่ครบ — ผู้ช่วยยังอ่านปฏิทินให้ไม่ได้
      </span>
      <button
        type="button"
        onClick={onOpen}
        className={`${NOTE_SM} ${PRESS} bg-[var(--nb-surface)] shrink-0 px-2.5 py-1 font-hand text-[14px] font-bold cursor-pointer`}
      >
        ตั้งค่าต่อ
      </button>
    </div>
  );
}
