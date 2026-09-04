"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { M365AuthProvider, useM365Auth } from "@/components/M365AuthProvider";

/**
 * ห่อแบบสำรวจด้วย MSAL ของแอป — ส่งชื่อ/อีเมลเข้า iframe เงียบ ๆ
 * (ไฟล์ HTML อย่างเดียวใช้ MSAL คนละเวอร์ชันกับแอป จึงอ่าน cache ไม่เจอ)
 */
function SurveyShell() {
  const { ready, account, login, getGraphToken } = useM365Auth();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [sent, setSent] = useState(false);

  const pushIdentity = useCallback(async () => {
    const win = iframeRef.current?.contentWindow;
    if (!win || !account) return;

    const payload: Record<string, string> = {
      name: account.name || "",
      username: account.username || "",
      upn: account.username || "",
      email: account.username || "",
    };

    try {
      const token = await getGraphToken();
      if (token) {
        const me = await fetch(
          "https://graph.microsoft.com/v1.0/me?$select=displayName,mail,userPrincipalName,jobTitle,department",
          { headers: { Authorization: `Bearer ${token}` } }
        ).then((r) => (r.ok ? r.json() : null));
        if (me) {
          if (me.displayName) payload.name = me.displayName;
          if (me.department) payload.department = me.department;
          if (me.jobTitle) payload.jobTitle = me.jobTitle;
          if (me.userPrincipalName) {
            payload.upn = me.userPrincipalName;
            payload.username = me.userPrincipalName;
          }
          if (me.mail) payload.email = me.mail;
          payload.accessToken = token;
        }
      }
    } catch {
      /* ชื่อจากบัญชีพอ */
    }

    win.postMessage({ type: "survey-m365", payload }, window.location.origin);
    setSent(true);
  }, [account, getGraphToken]);

  useEffect(() => {
    if (!ready || !account) return;
    void pushIdentity();
  }, [ready, account, pushIdentity]);

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column", background: "#eef2f5" }}>
      {!ready ? (
        <div style={{ padding: 16, fontFamily: "system-ui", color: "#64748b", fontSize: 14 }}>กำลังโหลด…</div>
      ) : !account ? (
        <div
          style={{
            padding: "12px 16px",
            fontFamily: "system-ui",
            fontSize: 13,
            background: "#fff",
            borderBottom: "1px solid #e2e8f0",
            display: "flex",
            gap: 10,
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          <span style={{ color: "#475569" }}>ล็อกอิน Microsoft 365 เพื่อติดชื่อผู้ตอบอัตโนมัติ (ไม่บังคับ)</span>
          <button
            type="button"
            onClick={() => void login()}
            style={{
              background: "#0f766e",
              color: "#fff",
              border: 0,
              borderRadius: 8,
              padding: "6px 12px",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            เข้าสู่ระบบ
          </button>
        </div>
      ) : (
        <div
          style={{
            padding: "8px 16px",
            fontFamily: "system-ui",
            fontSize: 12,
            color: "#64748b",
            background: "#fff",
            borderBottom: "1px solid #e2e8f0",
          }}
        >
          ตอบในชื่อ {account.name || account.username}
          {sent ? " · บันทึกอัตโนมัติตอนส่ง" : ""}
        </div>
      )}
      <iframe
        ref={iframeRef}
        title="แบบสำรวจ LINE"
        src="/survey-line-v2.html"
        onLoad={() => {
          if (account) void pushIdentity();
        }}
        style={{ flex: 1, width: "100%", border: 0, background: "#eef2f5" }}
      />
    </div>
  );
}

export default function SurveyPage() {
  return (
    <M365AuthProvider>
      <SurveyShell />
    </M365AuthProvider>
  );
}
