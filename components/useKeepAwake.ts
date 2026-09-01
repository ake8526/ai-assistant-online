"use client";

import { useEffect, useRef, useState } from "react";

const AWAKE_KEY = "ktisx_keep_awake";

/**
 * สะพานที่แอป Android ฉีดเข้ามา
 *
 * setKeepAwake — ถือธง FLAG_KEEP_SCREEN_ON
 * setDarkBars — ย้อมแถบสถานะ/แถบปุ่มให้เข้ากับธีมที่เลือก (แอปรุ่นเก่าไม่มี จึงเป็น optional)
 */
type ScreenBridge = {
  setKeepAwake?: (on: boolean) => void;
  setDarkBars?: (dark: boolean) => void;
  /**
   * เปิดห้องประชุมด้วยแอป Teams (ไม่มีแอปจึงไปลิงก์) — มีตั้งแต่ APK 3.4
   *
   * ต้องเช็กก่อนเรียกเสมอ เพราะหน้าเว็บอัปเดททันทีแต่ APK ต้องลงด้วยมือ
   * — เคยส่งลิงก์ intent:// ไปให้แอปรุ่นเก่าที่ดักไม่ได้ กดแล้วขึ้น ERR_UNKNOWN_URL_SCHEME
   */
  openMeeting?: (url: string) => void;
};

export function appBridge(): ScreenBridge | null {
  if (typeof window === "undefined") return null;
  const b = (window as unknown as { KtisxApp?: ScreenBridge }).KtisxApp;
  return b && typeof b.setKeepAwake === "function" ? b : null;
}

export type KeepAwake = { on: boolean; supported: boolean; toggle: () => void };

/**
 * กันจอดับ — ต้องเรียกจากที่ที่อยู่ตลอดอายุแอป ไม่ใช่ในหน้าตั้งค่า
 *
 * ตอนแรกฮุคนี้อยู่ใน SettingsBoard ซึ่งถูกถอดทิ้งทุกครั้งที่สลับออกจากแท็บตั้งค่า
 * cleanup จึงสั่งปลดธงกันจอดับทันทีที่ผู้ใช้เปลี่ยนแท็บ ผลคือสวิตช์ขึ้นว่าเปิด
 * แต่จอดับทุกที่นอกหน้าตั้งค่า — ต้องยกขึ้นไปไว้ที่เปลือกแอปที่ไม่ถูกถอด
 *
 * สองทางเรียงตามความน่าเชื่อถือ:
 * 1. ในแอป — ให้ Android ถือธง FLAG_KEEP_SCREEN_ON เอง ระบบไม่แย่งคืน
 * 2. บนเบราว์เซอร์ — Screen Wake Lock ซึ่งระบบยึดคืนได้ และหลุดเมื่อหน้าถูกซ่อน
 *    จึงต้องขอใหม่ทุกครั้งที่กลับมาเห็นหน้าจอ
 */
export function useKeepAwake(): KeepAwake {
  const [on, setOn] = useState(false);
  const [supported, setSupported] = useState(true);
  const lockRef = useRef<WakeLockSentinel | null>(null);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSupported(!!appBridge() || (typeof navigator !== "undefined" && "wakeLock" in navigator));
    try {
      setOn(localStorage.getItem(AWAKE_KEY) === "1");
    } catch {
      /* โหมดส่วนตัวอ่านไม่ได้ ก็ถือว่าปิด */
    }
  }, []);

  useEffect(() => {
    const bridge = appBridge();
    if (bridge) {
      bridge.setKeepAwake?.(on);
      return;
    }

    if (!on) {
      void lockRef.current?.release().catch(() => {});
      lockRef.current = null;
      return;
    }

    let dead = false;
    const acquire = async () => {
      if (dead || document.visibilityState !== "visible") return;
      if (!("wakeLock" in navigator)) return;
      try {
        lockRef.current = await navigator.wakeLock.request("screen");
      } catch {
        /* ระบบปฏิเสธ (แบตต่ำ / ประหยัดพลังงาน) — ขอใหม่รอบหน้า */
      }
    };
    void acquire();
    document.addEventListener("visibilitychange", acquire);
    return () => {
      dead = true;
      document.removeEventListener("visibilitychange", acquire);
      void lockRef.current?.release().catch(() => {});
      lockRef.current = null;
    };
  }, [on]);

  const toggle = () => {
    const next = !on;
    setOn(next);
    try {
      localStorage.setItem(AWAKE_KEY, next ? "1" : "0");
    } catch {
      /* จำไม่ได้ก็ยังใช้ได้ในรอบนี้ */
    }
  };

  return { on, supported, toggle };
}
