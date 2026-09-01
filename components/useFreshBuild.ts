"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** ตอนเปิดแอปอยู่ — เช็คถี่เพื่อรู้ว่ามี deploy ใหม่ภายในไม่กี่สิบวินาที */
const CHECK_VISIBLE_MS = 20_000;
/** ตอนสลับไปแอปอื่น — เช็คช้าลง ประหยัดแบต/เน็ต (กลับมาแล้วเช็คทันทีอยู่แล้ว) */
const CHECK_HIDDEN_MS = 3 * 60_000;
/** ช่วงต้นอายุของหน้า ถือว่าเพิ่งเปิดแอป — เจอของเก่าให้โหลดใหม่ทันที */
const STARTUP_MS = 20_000;
/** หน่วงสั้น ๆ ก่อนโหลดใหม่ตอนกำลังดูอยู่ — ให้เห็นแถบ "มีรุ่นใหม่" แวบหนึ่ง */
const AUTO_RELOAD_DELAY_MS = 1_200;
const RELOAD_AT_KEY = "ktisx_fresh_reload_at";

/**
 * โหลดหน้าใหม่เองเมื่อโค้ดในจอเป็นของเก่ากว่าที่เซิร์ฟเวอร์ให้บริการ
 *
 * แอปบนมือถือเป็น WebView ที่ไม่โหลดหน้าใหม่ตอนเปิดจากรายการแอปล่าสุด หน้าเดิม
 * ยังอยู่ในหน่วยความจำ JavaScript ตัวเก่าจึงทำงานต่อไป ต้องปิดแอปจากรายการแอป
 * ล่าสุดเท่านั้นถึงจะได้ของใหม่ — ซึ่งไม่มีใครเดาได้ และทำให้เข้าใจผิดว่าที่แก้ไป
 * แล้วยังไม่หาย ยิ่งงงเพราะรอบเดียวกันนั้นส่วนที่แก้ฝั่งเซิร์ฟเวอร์หายไปแล้ว
 * (เกิดขึ้นจริง: ห้องซ้ำหายเพราะแก้ที่เซิร์ฟเวอร์ แต่บั๊กแชทยังอยู่เพราะโค้ดเก่า)
 *
 * เทียบสองค่า:
 *   <meta name="ktisx-build"> = รหัสของโค้ดชุดที่หน้านี้โหลดมา (เซิร์ฟเวอร์ฝังไว้)
 *   /api/version              = รหัสที่เซิร์ฟเวอร์ให้บริการตอนนี้
 *
 * ทำไมไม่ "push" จาก Vercel ตรงเข้าแอป: เบราว์เซอร์/WebView ไม่มีช่องรับ
 * deploy event โดยตรงโดยไม่สมัคร Web Push — จึงยิง /api/version ถี่ ๆ แทน
 * (ประมาณทุก 20 วิตอนเปิดอยู่) พอเห็นรุ่นใหม่ก็โหลดเองในจังหวะที่ปลอดภัย
 */
/** รหัสโค้ดที่กำลังรันในจอ / ที่เซิร์ฟเวอร์ให้บริการ — เอาไปโชว์ในหน้าตั้งค่า */
export type BuildInfo = { mine: string; live: string; stale: boolean; refresh: () => void };

function isTyping(): boolean {
  const el = document.activeElement;
  if (!el || !(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

export function useFreshBuild(): BuildInfo {
  const staleRef = useRef(false);
  const [info, setInfo] = useState<{ mine: string; live: string; stale: boolean }>({
    mine: "",
    live: "",
    stale: false,
  });
  const refresh = useCallback(() => window.location.reload(), []);

  useEffect(() => {
    let alive = true;
    let intervalId = 0;
    let autoReloadTimer = 0;
    const bornAt = Date.now();
    const mine =
      document.querySelector('meta[name="ktisx-build"]')?.getAttribute("content")?.trim() || "";

    // อ่านจาก <meta> ที่มาพร้อมหน้า ไม่ได้เปลี่ยนอีกตลอดอายุหน้า จึงตั้งครั้งเดียวพอ
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setInfo((p) => (p.mine === mine ? p : { ...p, mine }));

    // ไม่รู้ว่าตัวเองเป็น build ไหน ก็เทียบอะไรไม่ได้ อย่าเดาแล้วรีเฟรชมั่ว
    if (!mine) return;

    const reload = () => {
      if (!alive) return;
      staleRef.current = false;
      // กันวนซ้ำ: ถ้า HTML ที่ได้กลับมายังเป็นตัวเก่า (แคชค้างที่ขอบเครือข่าย)
      // การโหลดใหม่จะไม่ช่วยอะไรและจะวนไม่จบ — ยอมโหลดเองไม่เกินครั้งเดียวต่อนาที
      try {
        const last = Number(sessionStorage.getItem(RELOAD_AT_KEY) || "0");
        if (Date.now() - last < 60_000) return;
        sessionStorage.setItem(RELOAD_AT_KEY, String(Date.now()));
      } catch {
        /* โหมดส่วนตัวเขียนไม่ได้ ก็ยอมให้โหลด */
      }
      window.location.reload();
    };

    const scheduleAutoReload = () => {
      if (autoReloadTimer) return;
      autoReloadTimer = window.setTimeout(() => {
        autoReloadTimer = 0;
        if (!alive || !staleRef.current) return;
        // กำลังพิมพ์อยู่ — อย่าตัดบทสนทนา ให้แถบ "มีรุ่นใหม่" บอกแทน
        if (document.visibilityState === "visible" && isTyping()) return;
        reload();
      }, AUTO_RELOAD_DELAY_MS);
    };

    const check = async () => {
      if (!alive || staleRef.current) return;
      let live = "";
      try {
        const r = await fetch("/api/version", { cache: "no-store" });
        if (!r.ok) return;
        const j = (await r.json()) as { build?: string };
        live = typeof j.build === "string" ? j.build : "";
      } catch {
        return; // ออฟไลน์ก็ไม่ต้องทำอะไร ค่อยเช็คใหม่รอบหน้า
      }
      if (!alive || !live) return;
      setInfo({ mine, live, stale: live !== mine });
      if (live === mine) return;

      staleRef.current = true;
      // เพิ่งเปิด / ไม่ได้มองจอ / ไม่ได้พิมพ์ → โหลดใหม่ให้เองใกล้เคียงเรียลไทม์
      if (Date.now() - bornAt < STARTUP_MS || document.visibilityState !== "visible") {
        reload();
        return;
      }
      if (!isTyping()) scheduleAutoReload();
    };

    const armInterval = () => {
      if (intervalId) window.clearInterval(intervalId);
      const ms =
        document.visibilityState === "visible" ? CHECK_VISIBLE_MS : CHECK_HIDDEN_MS;
      intervalId = window.setInterval(() => void check(), ms);
    };

    const onVisibility = () => {
      armInterval();
      if (document.visibilityState !== "visible") return;
      if (staleRef.current) {
        if (!isTyping()) reload();
        return;
      }
      void check();
    };

    // กลับมาโฟกัสหน้าต่าง (เช่น จากสลับแอปในบาง WebView ที่ไม่ยิง visibility)
    const onFocus = () => {
      if (staleRef.current && !isTyping()) reload();
      else void check();
    };

    void check();
    armInterval();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);
    return () => {
      alive = false;
      if (intervalId) window.clearInterval(intervalId);
      if (autoReloadTimer) window.clearTimeout(autoReloadTimer);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  return { ...info, refresh };
}
