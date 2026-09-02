"use client";

import React, { useEffect } from "react";

/**
 * กล่องยืนยันของหน้า ops
 *
 * ของเดิมใช้ปุ่มสองจังหวะ — กดครั้งแรกเปลี่ยนข้อความเป็น "ยืนยัน…" ครั้งที่สอง
 * จึงทำจริง ซึ่งทำงานถูกต้องแต่มองไม่เห็น: แถวหนึ่งมีปุ่มแดงสี่ปุ่มติดกัน
 * ข้อความที่เปลี่ยนไปเงียบ ๆ ไม่ได้บอกว่ากำลังจะทำอะไรกับใคร
 *
 * กล่องนี้บอกครบสามอย่างก่อนลงมือ: ทำอะไร · กับใคร · แล้วจะเกิดอะไรขึ้น
 * และปุ่มยืนยันเขียนชื่อการกระทำไว้ตรง ๆ ("ยืนยันระงับไลน์") ไม่ใช่คำว่า
 * "ตกลง" ลอย ๆ ที่ใช้ตอบคำถามอะไรก็ได้
 *
 * Esc หรือกดพื้นหลัง = ยกเลิก ทางออกต้องหาง่ายกว่าทางเดินหน้าเสมอ
 */
export type ConfirmSpec = {
  title: string;
  /** ใคร/อะไรที่จะโดน — เขียนให้เห็นตัวจริง ไม่ใช่ "รายการที่เลือก" */
  target?: string;
  /** ผลที่จะเกิด บรรทัดละข้อ */
  lines?: string[];
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
};

const CSS = `
.cfm-wrap{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;padding:18px;
  background:rgba(0,0,0,.62);font-family:'IBM Plex Sans Thai','Segoe UI',system-ui,sans-serif}
.cfm{background:#171718;border:1px solid #3a3a3c;border-radius:14px;max-width:420px;width:100%;
  padding:18px 18px 16px;color:#ececec;box-shadow:0 18px 50px rgba(0,0,0,.55)}
.cfm h3{font-size:17px;font-weight:700;margin:0 0 8px}
.cfm .who{font-size:14px;color:#7dd3fc;margin-bottom:10px;word-break:break-all}
.cfm ul{margin:0 0 14px 18px;padding:0}
.cfm li{font-size:13.5px;color:#c9c9c9;margin-bottom:5px;line-height:1.55}
.cfm .row{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap}
.cfm button{font:inherit;font-size:13.5px;border-radius:9px;padding:6px 14px;cursor:pointer;
  background:#232325;color:#ececec;border:1px solid #3a3a3c}
.cfm button:hover{background:#2c2c2f}
.cfm button.go{border-color:#166534;color:#4ade80}
.cfm button.go.danger{background:#7f1d1d;border-color:#7f1d1d;color:#fff}
`;

export function ConfirmDialog({
  spec,
  onCancel,
}: {
  spec: ConfirmSpec | null;
  onCancel: () => void;
}) {
  useEffect(() => {
    if (!spec) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [spec, onCancel]);

  if (!spec) return null;
  return (
    <div className="cfm-wrap" onClick={onCancel}>
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <div className="cfm" onClick={(e) => e.stopPropagation()}>
        <h3>{spec.title}</h3>
        {spec.target && <div className="who">{spec.target}</div>}
        {!!spec.lines?.length && (
          <ul>
            {spec.lines.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
        )}
        <div className="row">
          <button onClick={onCancel}>ยกเลิก</button>
          <button
            className={`go${spec.danger ? " danger" : ""}`}
            onClick={() => {
              spec.onConfirm();
              onCancel();
            }}
          >
            {spec.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
