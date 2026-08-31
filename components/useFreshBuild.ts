"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/* เช็คถี่พอที่จะเห็น build ใหม่ในไม่กี่นาทีหลัง deploy — เป็นการยิง JSON สั้น ๆ
   ครั้งเดียวต่อรอบ ถูกกว่าการที่ผู้ใช้ใช้ของเก่าอยู่โดยไม่รู้ตัว */
const CHECK_MS = 3 * 60_000;
/** ช่วงต้นอายุของหน้า ถือว่าเพิ่งเปิดแอป — เจอของเก่าให้โหลดใหม่ทันที */
const STARTUP_MS = 20_000;
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
 * จังหวะโหลดใหม่: เพิ่งเปิดแอป หรือตอนผู้ใช้สลับออกไปแล้วกลับมา — ไม่ตัดจบกลาง
 * ที่กำลังพิมพ์อยู่ ถ้าเจอระหว่างใช้งานก็จดไว้แล้วรอจังหวะนั้น
 */
/** รหัสโค้ดที่กำลังรันในจอ / ที่เซิร์ฟเวอร์ให้บริการ — เอาไปโชว์ในหน้าตั้งค่า */
export type BuildInfo = { mine: string; live: string; stale: boolean; refresh: () => void };

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
      // เพิ่งเปิดแอปมา หรือกำลังไม่ได้ดูอยู่ — โหลดใหม่ได้เลย ไม่มีอะไรให้เสีย
      if (Date.now() - bornAt < STARTUP_MS || document.visibilityState !== "visible") reload();
    };

    const onVisibility = () => {
      if (document.visibilityState !== "visible") return;
      if (staleRef.current) reload();
      else void check();
    };

    void check();
    const id = setInterval(() => void check(), CHECK_MS);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      alive = false;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return { ...info, refresh };
}
