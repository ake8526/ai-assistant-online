"use client";

import { X } from "lucide-react";
import AssistantTab from "@/components/AssistantTab";
import { NOTE_SM, N_BLUE, PRESS } from "@/components/noteStyles";
import type { ContextChip } from "@/lib/sheetContextChips";

type Props = {
  open: boolean;
  chatFocus: boolean;
  contextChips: ContextChip[];
  seed?: string;
  onSeedUsed: () => void;
  onClose: () => void;
  onShowWork: () => void;
  onUserSend: () => void;
  clearSignal?: number;
  canTest?: boolean;
  onBooked?: () => void;
  /** เปลี่ยนค่าเมื่อปิด sheet เพื่อรีเซ็ตบทสนทนาใน sheet */
  instanceKey: number;
  hasCommandBar?: boolean;
};

/** Bottom sheet ผู้ช่วย — เปิดจากแถบสั่งงานโดยไม่สลับแท็บ */
export default function AssistantSheet({
  open,
  chatFocus,
  contextChips,
  seed,
  onSeedUsed,
  onClose,
  onShowWork,
  onUserSend,
  clearSignal,
  canTest,
  onBooked,
  instanceKey,
  hasCommandBar = false,
}: Props) {
  if (!open) return null;

  const bottomClass = hasCommandBar
    ? "bottom-[calc(7.25rem+env(safe-area-inset-bottom))]"
    : "bottom-[calc(4.25rem+env(safe-area-inset-bottom))]";

  return (
    <>
      <button
        type="button"
        aria-label="ปิดผู้ช่วย"
        className="fixed inset-0 z-40 bg-black/35"
        onClick={onClose}
      />
      <div
        className={`fixed inset-x-0 ${bottomClass} z-50 flex flex-col border-t-2 border-[var(--nb-ink)] bg-[var(--nb-board)] rounded-t-[20px] shadow-[0_-4px_0_var(--nb-ink)] transition-[max-height] duration-250 ${
          chatFocus ? "max-h-[92dvh]" : "max-h-[78dvh]"
        }`}
      >
        <div className="shrink-0 flex items-center gap-2 px-4 py-2.5 border-b-2 border-[var(--nb-ink)] bg-[var(--nb-surface)]">
          <span className="flex-1 font-marker text-[15px]">ผู้ช่วย</span>
          {chatFocus && (
            <button
              type="button"
              onClick={onShowWork}
              className={`${NOTE_SM} ${PRESS} ${N_BLUE} px-2.5 py-1 font-hand text-[14px] font-bold cursor-pointer`}
            >
              แสดงงาน
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label="ปิด"
            className={`${NOTE_SM} ${PRESS} grid place-items-center w-9 h-9 cursor-pointer`}
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <AssistantTab
          key={instanceKey}
          seed={seed}
          onSeedUsed={onSeedUsed}
          clearSignal={clearSignal}
          canTest={canTest}
          onBooked={onBooked}
          onUserSend={onUserSend}
          contextChips={contextChips}
          hideContextChips={chatFocus}
          welcomeText="พิมพ์สั่งงานได้เลยครับ — หรือแตะ chip ด้านล่าง"
        />
      </div>
    </>
  );
}
