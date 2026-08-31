"use client";

import React from "react";
import { BOARD, FOLD, INK_2, INK_3, N_PURPLE, NOTE, NOTE_SM } from "@/components/noteStyles";

/** สถานะของงานหนึ่งชิ้นที่แอปทำระหว่างเปิด */
export type StepState = "wait" | "run" | "done" | "fail";

export type SplashSteps = {
  connect: StepState;
  calendar: StepState;
  rooms: StepState;
};

export const SPLASH_START: SplashSteps = { connect: "run", calendar: "wait", rooms: "wait" };

type Props = {
  steps: SplashSteps;
  /** จำนวนนัดที่ดึงมาได้ — เอาไปบอกที่บรรทัดสถานะ */
  eventCount?: number;
  /** true เมื่อทุกอย่างเสร็จแล้ว ให้ฉากยกตัวเองออกไป */
  leaving?: boolean;
};

/** งานเสร็จกี่ชิ้นจากสามชิ้น — เอาไปเป็นความยาวแถบ */
function progress(steps: SplashSteps): number {
  const done = Object.values(steps).filter((v) => v === "done" || v === "fail").length;
  return Math.round((done / 3) * 100);
}

/** ข้อความบรรทัดล่าง — บอกว่ากำลังรออะไรอยู่ ณ ตอนนั้น */
function status(steps: SplashSteps, count?: number): string {
  if (Object.values(steps).some((s) => s === "fail")) return "บางส่วนดึงไม่ได้ เข้าใช้งานต่อได้ครับ";
  if (steps.connect === "run") return "กำลังเชื่อม Microsoft 365…";
  if (steps.calendar === "run") return "กำลังดึงปฏิทินของคุณ…";
  if (steps.rooms === "run")
    return count === undefined ? "กำลังเช็คสถานะห้องประชุม…" : `ได้ ${count} นัด · เช็คห้องประชุม…`;
  return "พร้อมแล้วครับ";
}

/**
 * ฉากโหลดตอนเปิดแอป — แถบแรเงาเดินตามงานที่ทำเสร็จจริง (เชื่อม M365 → ปฏิทิน →
 * ห้องประชุม) ไม่ใช่ตั้งเวลาไว้ ถ้างานไหนพลาดก็นับว่าจบแล้วปล่อยเข้าแอปต่อ
 * โดยบอกไว้ที่บรรทัดล่าง ไม่ขวางผู้ใช้
 */
export default function SplashScreen({ steps, eventCount, leaving = false }: Props) {
  return (
    <div
      className={`fixed inset-0 z-50 ${BOARD} flex flex-col items-center justify-center gap-5 p-7 transition-all duration-500 ${
        leaving ? "opacity-0 -translate-y-3.5 scale-[1.02] pointer-events-none" : ""
      }`}
    >
      <div className={`${NOTE_SM} ${N_PURPLE} px-3 py-0.5 -rotate-2 font-hand text-[15px] font-bold`}>
        KTIS Group · Microsoft 365
      </div>

      <div className={`${NOTE} ${FOLD} bg-[var(--nb-surface)] px-6 pt-5 pb-4 flex flex-col items-center gap-1 -rotate-[0.7deg]`}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/ktisx-reading-video.gif?v=8"
          alt="ผู้ช่วย KTIS X"
          className="w-28 h-32 object-contain"
        />
        <h1 className="font-marker text-[20px]">KTIS X ผู้ช่วยงาน</h1>
      </div>

      <div
        className={`${NOTE_SM} bg-[var(--nb-surface)] w-[210px] h-[18px] overflow-hidden`}
        role="progressbar"
        aria-valuenow={progress(steps)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="ความคืบหน้าการเปิดแอป"
      >
        <div
          className="h-full transition-[width] duration-500 ease-out"
          style={{
            width: `${progress(steps)}%`,
            borderRight: progress(steps) ? "2px solid var(--nb-ink)" : "none",
            backgroundImage: "repeating-linear-gradient(45deg,var(--nb-ink) 0 2px,transparent 2px 7px)",
          }}
        />
      </div>

      <p className={`font-hand text-[17px] ${INK_2} -rotate-1 text-center min-h-[26px]`}>
        {status(steps, eventCount)}
      </p>

      <p className={`font-hand text-[15px] ${INK_3} absolute bottom-7`}>KTIS X · v2.7</p>
    </div>
  );
}
