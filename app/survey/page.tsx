"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { M365AuthProvider, useM365Auth } from "@/components/M365AuthProvider";

/**
 * ห่อแบบสำรวจด้วย MSAL ของแอป — ส่งชื่อ/โทเคนเข้า iframe ตอนโหลดและตอนกดส่ง
 */
function SurveyShell() {
  const { ready, account, login, getToken, getGraphToken } = useM365Auth();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [sent, setSent] = useState(false);

  const buildPayload = useCallback(async () => {
    if (!account) return null;
    const payload: Record<string, string> = {
      name: account.name || "",
      username: account.username || "",
      upn: account.username || "",
      email: account.username || "",
    };

    let accessToken = "";
    try {
      accessToken = (await getGraphToken()) || (await getToken()) || "";
    } catch {
      try {
        accessToken = (await getToken()) || "";
      } catch {
        accessToken = "";
      }
    }
    if (accessToken) payload.accessToken = accessToken;

    if (accessToken) {
      try {
        const me = await fetch(
          "https://graph.microsoft.com/v1.0/me?$select=displayName,mail,userPrincipalName,jobTitle,department",
          { headers: { Authorization: `Bearer ${accessToken}` } }
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
        }
      } catch {
        /* ชื่อจากบัญชีพอ */
      }
    }

    return payload;
  }, [account, getGraphToken, getToken]);

  const pushIdentity = useCallback(async () => {
    const win = iframeRef.current?.contentWindow;
    if (!win || !account) return;
    const payload = await buildPayload();
    if (!payload) return;
    win.postMessage({ type: "survey-m365", payload }, window.location.origin);
    setSent(true);
  }, [account, buildPayload]);

  useEffect(() => {
    if (!ready || !account) return;
    void pushIdentity();
  }, [ready, account, pushIdentity]);

  useEffect(() => {
    const onMsg = (ev: MessageEvent) => {
      if (ev.origin !== window.location.origin) return;
      if (!ev.data || ev.data.type !== "survey-need-m365") return;
      void (async () => {
        const win = iframeRef.current?.contentWindow;
        if (!win) return;
        const payload = await buildPayload();
        if (!payload) {
          win.postMessage({ type: "survey-m365", payload: null }, window.location.origin);
          return;
        }
        win.postMessage({ type: "survey-m365", payload }, window.location.origin);
        setSent(true);
      })();
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [buildPayload]);

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
            background: "#fff7ed",
            borderBottom: "1px solid #fed7aa",
            display: "flex",
            gap: 10,
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          <span style={{ color: "#9a3412", fontWeight: 600 }}>
            ยังไม่ได้ล็อกอิน — กดเข้าสู่ระบบก่อนส่ง จะได้ติดชื่อในผลสำรวจ
          </span>
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
            เข้าสู่ระบบ Microsoft 365
          </button>
        </div>
      ) : (
        <div
          style={{
            padding: "8px 16px",
            fontFamily: "system-ui",
            fontSize: 12,
            color: "#0f766e",
            background: "#ecfdf5",
            borderBottom: "1px solid #a7f3d0",
            fontWeight: 600,
          }}
        >
          เชื่อมบัญชีแล้ว — คำตอบจะบันทึกอัตโนมัติตอนกดส่ง
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
