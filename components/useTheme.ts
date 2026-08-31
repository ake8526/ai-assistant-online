"use client";

import { useCallback, useEffect, useState } from "react";
import { appBridge } from "@/components/useKeepAwake";

export const THEME_KEY = "ktisx_theme";
export type ThemeMode = "light" | "dark" | "auto";
export const THEME_MODES: ThemeMode[] = ["light", "dark", "auto"];
export const THEME_LABEL: Record<ThemeMode, string> = {
  light: "สว่าง",
  dark: "มืด",
  auto: "ตามระบบ",
};

/** ธีมเริ่มต้นคือสว่าง — ตรงกับ data-theme ที่ HTML จากเซิร์ฟเวอร์ส่งมา */
export const THEME_DEFAULT: ThemeMode = "light";

function isMode(v: unknown): v is ThemeMode {
  return v === "light" || v === "dark" || v === "auto";
}

/** มืดจริงบนจอตอนนี้ (auto ต้องถามระบบ) — ใช้บอกแอปให้ย้อมแถบสถานะ */
function darkNow(mode: ThemeMode): boolean {
  if (mode === "dark") return true;
  if (mode === "light") return false;
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches === true;
}

export type Theme = { mode: ThemeMode; setMode: (m: ThemeMode) => void; dark: boolean };

/**
 * สวิตช์ธีมของแอป
 *
 * ค่าที่เลือกไปเขียนเป็น data-theme ที่ <html> ซึ่ง app/globals.css ใช้สลับจานสี
 * ของดีไซน์โน้ตทั้งชุด ตัวสคริปต์ใน <head> อ่าน localStorage คีย์เดียวกันก่อน
 * เบราว์เซอร์วาดจอแรก จอจึงไม่แวบเป็นสีขาวก่อนแล้วค่อยเปลี่ยนเป็นมืด
 *
 * เรียกที่เปลือกแอปที่เดียว แล้วส่งค่าลงไปให้หน้าตั้งค่าใช้
 */
export function useTheme(): Theme {
  const [mode, setModeState] = useState<ThemeMode>(THEME_DEFAULT);
  const [dark, setDark] = useState(false);

  const apply = useCallback((m: ThemeMode) => {
    document.documentElement.setAttribute("data-theme", m);
    const isDark = darkNow(m);
    setDark(isDark);
    // แถบสถานะและแถบปุ่มของ Android อยู่นอก WebView — ต้องบอกแอปเอง
    appBridge()?.setDarkBars?.(isDark);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", isDark ? "#1b1a19" : "#f1efe9");
  }, []);

  // อ่านค่าที่เคยเลือกไว้ (สคริปต์ใน <head> ตั้ง data-theme ไปแล้ว ตรงนี้แค่ตามให้ตรง)
  useEffect(() => {
    let saved: ThemeMode = THEME_DEFAULT;
    try {
      const raw = localStorage.getItem(THEME_KEY);
      if (isMode(raw)) saved = raw;
    } catch {
      /* โหมดส่วนตัวอ่านไม่ได้ ใช้ค่าเริ่มต้น */
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setModeState(saved);
    apply(saved);
  }, [apply]);

  // โหมด "ตามระบบ" ต้องขยับตามตอนระบบสลับธีมกลางวัน-กลางคืน
  useEffect(() => {
    if (mode !== "auto" || typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => apply("auto");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [mode, apply]);

  const setMode = useCallback(
    (m: ThemeMode) => {
      setModeState(m);
      apply(m);
      try {
        localStorage.setItem(THEME_KEY, m);
      } catch {
        /* จำไม่ได้ก็ยังใช้ได้ในรอบนี้ */
      }
    },
    [apply]
  );

  return { mode, setMode, dark };
}
