"use client";

import React, { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";

type Phase = "ask" | "locating" | "saving" | "done" | "error";

function SetGpsInner() {
  const sp = useSearchParams();
  const token = sp.get("t") || "";
  const as = (sp.get("as") || "work") === "home" ? "home" : "work";
  const where = as === "home" ? "บ้าน" : "ที่ทำงาน";

  const [phase, setPhase] = useState<Phase>("ask");
  const [msg, setMsg] = useState("");
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);

  const mapsUrl = useMemo(() => {
    if (!coords) return null;
    return `https://www.google.com/maps?q=${coords.lat},${coords.lng}`;
  }, [coords]);

  async function capture() {
    if (!token) {
      setPhase("error");
      setMsg("ลิงก์ไม่ครบ — กลับไปที่ LINE แล้วขอลิงก์ใหม่ครับ");
      return;
    }
    if (!navigator.geolocation) {
      setPhase("error");
      setMsg("มือถือเครื่องนี้ไม่รองรับ GPS ในเบราว์เซอร์ครับ");
      return;
    }
    setPhase("locating");
    setMsg("กำลังขอตำแหน่ง GPS… กดอนุญาตเมื่อระบบถามครับ");

    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;
        setCoords({ lat, lng });
        setPhase("saving");
        setMsg("บันทึกตำแหน่ง…");
        try {
          const res = await fetch("/api/set-gps", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token, lat, lng }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) {
            setPhase("error");
            setMsg(data.error || "บันทึกไม่สำเร็จ");
            return;
          }
          setPhase("done");
          setMsg(`บันทึก${where}เรียบร้อยแล้วครับ — กลับไปที่ LINE ได้เลย`);
        } catch {
          setPhase("error");
          setMsg("เชื่อมต่อเซิร์ฟเวอร์ไม่สำเร็จ — ลองใหม่อีกครั้งครับ");
        }
      },
      (err) => {
        setPhase("error");
        if (err.code === err.PERMISSION_DENIED) {
          setMsg("ยังไม่อนุญาตเข้าถึงตำแหน่ง — เปิด Location ให้เบราว์เซอร์แล้วลองอีกครั้งครับ");
        } else {
          setMsg("ดึง GPS ไม่สำเร็จ — ลองใหม่หรือส่งตำแหน่งจาก LINE (+ → ตำแหน่ง) แทนได้ครับ");
        }
      },
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 }
    );
  }

  useEffect(() => {
    document.title = `ตั้ง${where}จาก GPS`;
  }, [where]);

  return (
    <main
      style={{
        minHeight: "100dvh",
        display: "grid",
        placeItems: "center",
        padding: 24,
        fontFamily: "system-ui, Segoe UI, sans-serif",
        background: "linear-gradient(160deg, #ecfdf5 0%, #f0f9ff 50%, #fff 100%)",
        color: "#0f172a",
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 420,
          background: "#fff",
          borderRadius: 16,
          padding: "28px 24px",
          boxShadow: "0 12px 40px rgba(15,23,42,0.08)",
          border: "1px solid #e2e8f0",
        }}
      >
        <p style={{ margin: 0, fontSize: 13, color: "#64748b" }}>KTIS X AI Assistant</p>
        <h1 style={{ margin: "8px 0 12px", fontSize: 22, lineHeight: 1.3 }}>ตั้ง{where}จาก GPS</h1>
        <p style={{ margin: "0 0 20px", fontSize: 15, lineHeight: 1.55, color: "#334155" }}>
          บอทในแชทดึง GPS เองไม่ได้ครับ — กดปุ่มด้านล่างเพื่ออนุญาตตำแหน่งครั้งนี้ แล้วระบบจะบันทึกให้ทันที
        </p>

        {phase === "ask" && (
          <button
            type="button"
            onClick={capture}
            style={{
              width: "100%",
              border: 0,
              borderRadius: 12,
              padding: "14px 16px",
              background: "#0f766e",
              color: "#fff",
              fontSize: 16,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            ดึง GPS เป็น{where}ตอนนี้
          </button>
        )}

        {phase !== "ask" && (
          <p style={{ margin: "0 0 12px", fontSize: 15, lineHeight: 1.5 }}>{msg}</p>
        )}

        {coords && mapsUrl && (
          <p style={{ margin: "0 0 12px", fontSize: 13, color: "#64748b" }}>
            พิกัด: {coords.lat.toFixed(5)}, {coords.lng.toFixed(5)}
            <br />
            <a href={mapsUrl} target="_blank" rel="noreferrer">
              ดูบนแผนที่
            </a>
          </p>
        )}

        {(phase === "error" || phase === "done") && (
          <button
            type="button"
            onClick={() => {
              if (phase === "done") {
                try {
                  window.close();
                } catch {
                  /* ignore */
                }
              } else {
                setPhase("ask");
                setMsg("");
              }
            }}
            style={{
              width: "100%",
              border: "1px solid #cbd5e1",
              borderRadius: 12,
              padding: "12px 16px",
              background: phase === "done" ? "#0f766e" : "#fff",
              color: phase === "done" ? "#fff" : "#0f172a",
              fontSize: 15,
              fontWeight: 600,
              cursor: "pointer",
              marginTop: 8,
            }}
          >
            {phase === "done" ? "กลับไป LINE" : "ลองอีกครั้ง"}
          </button>
        )}
      </div>
    </main>
  );
}

export default function SetGpsPage() {
  return (
    <Suspense fallback={<main style={{ padding: 24 }}>กำลังโหลด…</main>}>
      <SetGpsInner />
    </Suspense>
  );
}
