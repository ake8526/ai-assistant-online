"use client";

import { Send } from "lucide-react";
import { NOTE, N_YELLOW, PRESS } from "@/components/noteStyles";

/** แถบสั่งงานเหนือ nav — เปิด Assistant sheet โดยไม่ต้องสลับไปแท็บผู้ช่วย */
export default function CommandBar({ onOpen }: { onOpen: () => void }) {
  return (
    <div className="shrink-0 px-3 pb-1.5 bg-[var(--nb-board)]">
      <div
        className={`${NOTE} ${N_YELLOW} ${PRESS} px-3 py-1.5 flex items-center gap-2 cursor-pointer`}
      >
        <button
          type="button"
          onClick={onOpen}
          className="flex-1 min-w-0 text-left text-[13.5px] text-[var(--nb-ink-3)] bg-transparent border-0 cursor-pointer"
        >
          พิมพ์สั่งงาน…
        </button>
        <button
          type="button"
          onClick={onOpen}
          aria-label="เปิดผู้ช่วย"
          className={`${NOTE} ${PRESS} ${N_YELLOW} grid place-items-center w-9 h-9 shrink-0 border-2 border-[var(--nb-ink)] rounded-full cursor-pointer`}
        >
          <Send className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
