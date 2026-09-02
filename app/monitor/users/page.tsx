"use client";

import React, { useCallback, useEffect, useState } from "react";
import { M365AuthProvider, useM365Auth } from "@/components/M365AuthProvider";

// ---------------------------------------------------------------------------
// /monitor/users — ใครเข้ามาทางไหน อนุญาตอะไรไว้ และระงับใครได้
//
// ข้อมูลนี้เคยกระจายอยู่สามตาราง ไม่มีที่ไหนตอบได้ในหน้าเดียวว่า "คนนี้ผูกไลน์
// แล้วหรือยัง ให้สิทธิ์อะไรไว้ ตั้งค่าไปถึงไหน" และไม่มีทางปิดการใช้งานของใคร
// นอกจากลบแถวใน Supabase ด้วยมือ — ซึ่งเจ้าตัวผูกกลับมาเองได้ทันที
//
// สีบอกสถานะ: เขียว = ใช้ทางไลน์ได้แล้ว · เหลือง = เข้าเว็บแต่ยังไม่ผูกไลน์
// แดง = ถูกระงับ
//
// ทุกปุ่มที่มีผลกับคนอื่นต้องกดสองครั้ง
// ---------------------------------------------------------------------------

type UserRow = {
  upn: string;
  line: { name: string; at: string | null; id: string } | null;
  ms: { at: string | null; scopes: string[] } | null;
  todoSync: boolean;
  devices: number;
  setUp: boolean;
  perms: string[];
  root: boolean;
  blocked: { line: boolean; web: boolean; at: string | null; by: string | null };
};
type Resp = { perms?: string[]; me?: string; users: UserRow[] };

const CSS = `
body{background:#0e0e0f}
.mus{min-height:100vh;background:#0e0e0f;color:#ececec;font-family:'IBM Plex Sans Thai','Segoe UI',system-ui,sans-serif;padding:22px 18px 70px}
.mus .wrap{max-width:1180px;margin:0 auto}
.mus .kick{color:#ee1b24;font-size:12px;letter-spacing:.16em;text-transform:uppercase}
.mus h1{font-size:23px;font-weight:700;margin:4px 0 2px}
.mus .sub{color:#8a8a8a;font-size:14px;margin-bottom:16px}
.mus .legend{display:flex;gap:14px;flex-wrap:wrap;font-size:12.5px;color:#8a8a8a;margin-bottom:14px}
.mus .card{background:#171718;border:1px solid #2a2a2c;border-radius:12px;padding:14px 16px;margin-bottom:14px}
.mus .scroll{overflow-x:auto}
.mus table{width:100%;border-collapse:collapse;font-size:13.5px;min-width:900px}
.mus th{text-align:left;color:#7c7c7c;font-weight:600;font-size:11.5px;padding:6px 8px;border-bottom:1px solid #2a2a2c;white-space:nowrap}
.mus td{padding:8px;border-bottom:1px solid #202022;vertical-align:top}
.mus tr:last-child td{border-bottom:none}
.mus .dot{display:inline-block;width:8px;height:8px;border-radius:999px;margin-right:7px;vertical-align:middle}
.mus .g{background:#4ade80}.mus .a{background:#fbbf24}.mus .r{background:#f87171}
.mus .who{font-size:14px}
.mus .dim{color:#7c7c7c;font-size:12px}
.mus .tag{display:inline-block;font-size:11px;padding:1px 7px;border-radius:999px;border:1px solid #333;margin:0 4px 4px 0;white-space:nowrap}
.mus .ok{color:#4ade80;border-color:#166534}
.mus .warn{color:#fbbf24;border-color:#78350f}
.mus .bad{color:#fca5a5;border-color:#7f1d1d}
.mus button{font:inherit;font-size:12.5px;background:#232325;color:#ececec;border:1px solid #3a3a3c;border-radius:8px;padding:3px 9px;cursor:pointer;margin:0 4px 4px 0;white-space:nowrap}
.mus button:hover:not(:disabled){background:#2c2c2f}
.mus button:disabled{opacity:.4;cursor:not-allowed}
.mus button.danger{border-color:#7f1d1d;color:#fca5a5}
.mus button.danger.armed{background:#7f1d1d;color:#fff}
.mus .msg{font-size:13.5px;color:#fbbf24;margin-top:10px}
.mus .center{min-height:70vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;text-align:center}
.mus .link{color:#7dd3fc;text-decoration:none}
`;

const TZ_MS = 7 * 3600_000;
const shortUpn = (u: string) => u.replace(/@ktisgroup\.com$/i, "");

function stamp(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(new Date(iso).getTime() + TZ_MS);
  if (Number.isNaN(d.getTime())) return "—";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(
    d.getUTCMinutes()
  )}`;
}

function UsersView({ getToken }: { getToken: () => Promise<string | null> }) {
  const [data, setData] = useState<Resp | null>(null);
  const [err, setErr] = useState("");
  const [denied, setDenied] = useState(false);
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState("");
  const [armed, setArmed] = useState("");

  const load = useCallback(async () => {
    try {
      const token = await getToken();
      const r = await fetch("/api/monitor/users", {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        cache: "no-store",
      });
      if (r.status === 403) {
        setDenied(true);
        return;
      }
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setDenied(false);
      setErr("");
      setData(d as Resp);
    } catch (e) {
      setErr(String(e).slice(0, 200));
    }
  }, [getToken]);

  /* เลื่อนการโหลดครั้งแรกออกไปหนึ่ง tick — lint ของโปรเจกต์ห้าม setState
     ตรง ๆ ในตัว effect */
  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [load]);

  const act = useCallback(
    async (tag: string, body: Record<string, unknown>, done: string) => {
      setBusy(tag);
      setMsg("");
      try {
        const token = await getToken();
        const r = await fetch("/api/monitor/users", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify(body),
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
        setMsg(done);
        await load();
      } catch (e) {
        setMsg(`ไม่สำเร็จ: ${String(e).slice(0, 180)}`);
      } finally {
        setBusy("");
        setArmed("");
      }
    },
    [getToken, load]
  );

  /** ปุ่มที่มีผลกับคนอื่น — กดครั้งแรกง้างไว้ ครั้งที่สองทำจริง */
  const twoStep = (
    key: string,
    label: string,
    confirmLabel: string,
    body: Record<string, unknown>,
    done: string,
    danger = true
  ) => (
    <button
      key={key}
      className={`${danger ? "danger" : ""}${armed === key ? " armed" : ""}`}
      disabled={!!busy}
      onClick={() => {
        if (armed !== key) {
          setArmed(key);
          return;
        }
        void act(key, body, done);
      }}
    >
      {busy === key ? "กำลังทำ…" : armed === key ? confirmLabel : label}
    </button>
  );

  if (denied) {
    return (
      <div className="mus">
        <style dangerouslySetInnerHTML={{ __html: CSS }} />
        <div className="center">
          <div className="kick">ไม่มีสิทธิ์</div>
          <div style={{ color: "#8a8a8a", maxWidth: 460, fontSize: 15 }}>
            หน้านี้เปิดให้เฉพาะผู้ที่ได้รับสิทธิ์ «จัดการสิทธิ์» — ขอสิทธิ์ได้ที่ผู้ดูแลระบบ
          </div>
          <a className="link" href="/monitor">
            ← กลับห้องทำงาน
          </a>
        </div>
      </div>
    );
  }

  const users = data?.users || [];
  const onLine = users.filter((u) => u.line && !u.blocked.line).length;
  const webOnly = users.filter((u) => !u.line).length;
  const blocked = users.filter((u) => u.blocked.line || u.blocked.web).length;

  return (
    <div className="mus">
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <div className="wrap">
        <div className="kick">AI ASSISTANT · ผู้ใช้งาน</div>
        <h1>จัดการผู้ใช้งานและช่องทาง</h1>
        <div className="sub">
          ทั้งหมด {users.length} คน ·{" "}
          <a className="link" href="/monitor">
            ห้องทำงาน
          </a>{" "}
          ·{" "}
          <a className="link" href="/monitor/todo">
            To Do
          </a>{" "}
          ·{" "}
          <a className="link" href="/monitor/admin">
            สิทธิ์
          </a>
        </div>
        <div className="legend">
          <span>
            <span className="dot g" />
            ใช้ทางไลน์ได้แล้ว {onLine}
          </span>
          <span>
            <span className="dot a" />
            เข้าเว็บแต่ยังไม่ผูกไลน์ {webOnly}
          </span>
          <span>
            <span className="dot r" />
            ถูกระงับ {blocked}
          </span>
        </div>

        <div className="card">
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>บัญชี</th>
                  <th>ไลน์</th>
                  <th>สิทธิ์ Microsoft</th>
                  <th>ตั้งค่า / อุปกรณ์</th>
                  <th>สิทธิ์ในระบบ</th>
                  <th>สั่งการ</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => {
                  const state = u.blocked.line || u.blocked.web ? "r" : u.line ? "g" : "a";
                  return (
                    <tr key={u.upn}>
                      <td>
                        <div className="who">
                          <span className={`dot ${state}`} />
                          {shortUpn(u.upn)}
                          {u.root && <span className="tag ok">เจ้าของระบบ</span>}
                        </div>
                        {(u.blocked.line || u.blocked.web) && (
                          <div className="dim">
                            ระงับ{u.blocked.line ? " ไลน์" : ""}
                            {u.blocked.web ? " เว็บ" : ""} · {stamp(u.blocked.at)}
                            {u.blocked.by ? ` · โดย ${shortUpn(u.blocked.by)}` : ""}
                          </div>
                        )}
                      </td>
                      <td>
                        {u.line ? (
                          <>
                            <div>{u.line.name || "(ไม่มีชื่อ)"}</div>
                            <div className="dim">
                              ผูก {stamp(u.line.at)} · {u.line.id}
                            </div>
                          </>
                        ) : (
                          <span className="tag warn">ยังไม่ผูก</span>
                        )}
                      </td>
                      <td>
                        {u.ms ? (
                          <>
                            <div>
                              {u.ms.scopes.length ? (
                                u.ms.scopes.map((s) => (
                                  <span key={s} className="tag ok">
                                    {s}
                                  </span>
                                ))
                              ) : (
                                <span className="tag warn">ไม่มีสิทธิ์ที่อ่านได้</span>
                              )}
                            </div>
                            <div className="dim">อัปเดต {stamp(u.ms.at)}</div>
                          </>
                        ) : (
                          <span className="tag warn">ยังไม่ให้สิทธิ์</span>
                        )}
                      </td>
                      <td>
                        <div>{u.setUp ? "ตั้งค่าแล้ว" : <span className="dim">ยังไม่ตั้งค่า</span>}</div>
                        <div className="dim">
                          {u.todoSync ? "To Do เปิด · " : ""}
                          {u.devices ? `${u.devices} เครื่อง` : "ไม่มีเครื่องแจ้งเตือน"}
                        </div>
                      </td>
                      <td>
                        {u.perms.length ? (
                          u.perms.map((p) => (
                            <span key={p} className="tag">
                              {p}
                            </span>
                          ))
                        ) : (
                          <span className="dim">—</span>
                        )}
                      </td>
                      <td>
                        {twoStep(
                          `bl${u.upn}`,
                          u.blocked.line ? "ปลดระงับไลน์" : "ระงับไลน์",
                          u.blocked.line ? "ยืนยันปลด" : "ยืนยันระงับ",
                          { action: "block", upn: u.upn, channel: "line", on: !u.blocked.line },
                          `${u.blocked.line ? "ปลดระงับ" : "ระงับ"}ไลน์ของ ${shortUpn(u.upn)} แล้ว`,
                          !u.blocked.line
                        )}
                        {twoStep(
                          `bw${u.upn}`,
                          u.blocked.web ? "ปลดระงับเว็บ" : "ระงับเว็บ/แอป",
                          u.blocked.web ? "ยืนยันปลด" : "ยืนยันระงับ",
                          { action: "block", upn: u.upn, channel: "web", on: !u.blocked.web },
                          `${u.blocked.web ? "ปลดระงับ" : "ระงับ"}เว็บของ ${shortUpn(u.upn)} แล้ว`,
                          !u.blocked.web
                        )}
                        {u.line &&
                          twoStep(
                            `ul${u.upn}`,
                            "ยกเลิกผูกไลน์",
                            "ยืนยันยกเลิก",
                            { action: "unlink_line", upn: u.upn },
                            `ยกเลิกการผูกไลน์ของ ${shortUpn(u.upn)} แล้ว`
                          )}
                        {u.ms &&
                          twoStep(
                            `rm${u.upn}`,
                            "ลบสิทธิ์ Microsoft",
                            "ยืนยันลบสิทธิ์",
                            { action: "revoke_ms", upn: u.upn },
                            `ลบสิทธิ์ Microsoft ที่เก็บไว้ของ ${shortUpn(u.upn)} แล้ว`
                          )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {msg && <div className="msg">{msg}</div>}
          {err && <div className="msg">{err}</div>}
        </div>

        <div className="card">
          <div style={{ fontSize: 13, color: "#9a9a9a", lineHeight: 1.7 }}>
            <b>ระงับ</b> = ปิดการใช้งานจริง ไลน์จะตอบว่าถูกระงับ ส่วนเว็บ/แอปเข้าไม่ได้เลย
            บัญชีเจ้าของระบบระงับไม่ได้ (กันล็อกตัวเองออกแล้วไม่มีใครปลดคืน)
            <br />
            <b>ยกเลิกผูกไลน์</b> = ลบการผูกออก เจ้าตัวผูกกลับมาเองได้ — ใช้ตอนเปลี่ยนบัญชีไลน์
            ไม่ใช่ตอนต้องการปิดการใช้งาน
            <br />
            <b>ลบสิทธิ์ Microsoft</b> = ลบ token ที่เก็บไว้ฝั่งเรา ไม่ได้ถอน consent ที่ Microsoft
            เจ้าตัวล็อกอินใหม่ก็ได้กลับมา จะตัดขาดจริงต้องใช้ระงับ
          </div>
        </div>
      </div>
    </div>
  );
}

function Gate() {
  const { account, login, getToken } = useM365Auth();
  if (!account) {
    return (
      <div className="mus">
        <style dangerouslySetInnerHTML={{ __html: CSS }} />
        <div className="center">
          <div className="kick">AI ASSISTANT · ผู้ใช้งาน</div>
          <div style={{ color: "#8a8a8a", fontSize: 15 }}>ต้องล็อกอิน Microsoft 365 เพื่อดูหน้านี้</div>
          <button onClick={() => login()}>เข้าสู่ระบบ M365</button>
        </div>
      </div>
    );
  }
  return <UsersView getToken={getToken} />;
}

export default function MonitorUsersPage() {
  return (
    <M365AuthProvider>
      <Gate />
    </M365AuthProvider>
  );
}
