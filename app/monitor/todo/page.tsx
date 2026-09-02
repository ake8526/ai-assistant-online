"use client";

import React, { useCallback, useEffect, useState } from "react";
import { M365AuthProvider, useM365Auth } from "@/components/M365AuthProvider";

// ---------------------------------------------------------------------------
// /monitor/todo — จัดการงานและการซิงค์ Microsoft To Do
//
// เหตุที่ต้องมี: 13 ส.ค. 2026 ประชุมครั้งเดียวถูกสรุปซ้ำ 8 รอบใน 20 นาที
// กลายเป็น 43 งานกองอยู่กับคนสองคนที่ไม่ได้เป็นเจ้าของงานสักใบ กว่าจะเก็บกวาด
// ได้ต้องไล่ลบจากหลังบ้านทีละคน หน้านี้จัดกลุ่มตาม "ประชุมไหน วันไหน ของใคร"
// ให้เห็นทั้งกองแล้วลบทีเดียว และเปิด/ปิดการซิงค์รายคนได้โดยไม่ต้องแตะ DB
//
// ลบได้ทีละกลุ่มเท่านั้น และต้องกดยืนยันซ้ำ — ไม่มีปุ่มล้างทั้งตาราง
// ---------------------------------------------------------------------------

type UserRow = {
  upn: string;
  on: boolean;
  consent: boolean;
  linked: boolean;
  cards: number;
  tasks: number;
  lastSync: string | null;
  items: UserItem[];
};
type Item = { id: number; title: string; responsible: string; status: string; due: string | null };
type UserItem = Item & { source: string; createdAt: string; inTodo: boolean };
type Group = {
  key: string;
  owner: string;
  source: string;
  day: string;
  n: number;
  ids: number[];
  items: Item[];
};
type Resp = { perms?: string[]; users: UserRow[]; groups: Group[]; total: number };

const CSS = `
/* เลย์เอาต์หลักของแอปเป็นพื้นสว่าง หน้านี้เป็นพื้นมืด — ถ้าไม่ทาสีที่ body ด้วย
   เนื้อหาที่ยาวกว่าหนึ่งจอจะเห็นพื้นขาวโผล่ใต้กล่องเมื่อเลื่อนลง */
body{background:#0e0e0f}
.mtd{min-height:100vh;background:#0e0e0f;color:#ececec;font-family:'IBM Plex Sans Thai','Segoe UI',system-ui,sans-serif;padding:22px 18px 70px}
.mtd .wrap{max-width:1040px;margin:0 auto}
.mtd .kick{color:#ee1b24;font-size:12px;letter-spacing:.16em;text-transform:uppercase}
.mtd h1{font-size:23px;font-weight:700;margin:4px 0 2px}
.mtd .sub{color:#8a8a8a;font-size:14px;margin-bottom:18px}
.mtd .card{background:#171718;border:1px solid #2a2a2c;border-radius:12px;padding:14px 16px;margin-bottom:14px}
.mtd h2{font-size:13px;color:#9a9a9a;font-weight:600;letter-spacing:.06em;margin-bottom:10px}
.mtd .scroll{overflow-x:auto}
.mtd table{width:100%;border-collapse:collapse;font-size:14px;min-width:660px}
.mtd th{text-align:left;color:#7c7c7c;font-weight:600;font-size:12px;padding:6px 8px;border-bottom:1px solid #2a2a2c;white-space:nowrap}
.mtd td{padding:7px 8px;border-bottom:1px solid #202022;vertical-align:middle}
.mtd tr:last-child td{border-bottom:none}
.mtd .num{text-align:right;font-variant-numeric:tabular-nums;color:#c9c9c9}
.mtd .tag{display:inline-block;font-size:11.5px;padding:1px 7px;border-radius:999px;border:1px solid #333;white-space:nowrap}
.mtd .ok{color:#4ade80;border-color:#166534}
.mtd .off{color:#8a8a8a}
.mtd .warn{color:#fbbf24;border-color:#78350f}
.mtd button{font:inherit;font-size:13px;background:#232325;color:#ececec;border:1px solid #3a3a3c;border-radius:8px;padding:4px 11px;cursor:pointer;white-space:nowrap}
.mtd button:hover:not(:disabled){background:#2c2c2f}
.mtd button:disabled{opacity:.45;cursor:not-allowed}
.mtd button.danger{border-color:#7f1d1d;color:#fca5a5}
.mtd button.danger.armed{background:#7f1d1d;color:#fff}
.mtd .ghead{display:flex;align-items:center;gap:10px;flex-wrap:wrap;cursor:pointer}
.mtd .gday{color:#7dd3fc;font-size:13px;font-variant-numeric:tabular-nums}
.mtd .gsrc{font-size:15px;font-weight:600;flex:1;min-width:200px}
.mtd .gowner{color:#8a8a8a;font-size:13px}
.mtd .gn{font-size:13px;color:#c9c9c9}
.mtd ul{margin:10px 0 0 0;padding:0;list-style:none;border-top:1px solid #202022}
.mtd li{padding:6px 2px;border-bottom:1px solid #202022;font-size:14px;display:flex;gap:8px}
.mtd li:last-child{border-bottom:none}
.mtd li .id{color:#6f6f6f;font-variant-numeric:tabular-nums;min-width:46px}
.mtd li .resp{color:#7dd3fc;font-size:13px;white-space:nowrap}
.mtd button.plain{background:none;border:none;padding:0;color:#ececec;font-size:14px}
.mtd button.plain:hover{background:none;color:#7dd3fc}
.mtd table.inner{min-width:0;font-size:13px;margin-top:4px}
.mtd table.inner th{font-size:11px;padding:4px 8px 4px 0;border-bottom:1px solid #2a2a2c}
.mtd table.inner td{padding:5px 8px 5px 0;border-bottom:1px solid #1c1c1e;vertical-align:top}
.mtd .msg{font-size:13.5px;color:#fbbf24;margin-top:10px}
.mtd .center{min-height:70vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;text-align:center}
.mtd .link{color:#7dd3fc;text-decoration:none}
`;

function fmtAgo(iso: string | null): string {
  if (!iso) return "—";
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return "เมื่อครู่";
  if (m < 60) return `${m} นาทีที่แล้ว`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} ชม.ที่แล้ว` : `${Math.round(h / 24)} วันที่แล้ว`;
}

const shortUpn = (u: string) => u.replace(/@ktisgroup\.com$/i, "");

const TZ_MS = 7 * 3600_000;

/** เวลาไทยแบบอ่านเร็ว — วัน/เดือน ชม.:นาที */
function stamp(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(new Date(iso).getTime() + TZ_MS);
  if (Number.isNaN(d.getTime())) return "—";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/** ที่มาของงาน — ชื่อประชุมยาว ๆ ตัดให้พออ่าน ส่วนค่าที่ระบบใช้เองแปลเป็นคำไทย */
function sourceLabel(src: string): string {
  const s = (src || "").trim();
  if (!s || s === "manual") return "เพิ่มเอง";
  if (s === "todo") return "พิมพ์ใน To Do";
  if (s === "meeting_auto") return "จากสรุปประชุม";
  return s;
}

function TodoView({ getToken }: { getToken: () => Promise<string | null> }) {
  const [data, setData] = useState<Resp | null>(null);
  const [err, setErr] = useState("");
  const [denied, setDenied] = useState(false);
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState("");
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [openUser, setOpenUser] = useState<Record<string, boolean>>({});
  /* ปุ่มลบต้องกดสองครั้ง — ครั้งแรกแค่ "ง้าง" ไว้ ครั้งที่สองจึงลบจริง
     ของที่ลบไปแล้วไม่มีปุ่มเรียกคืนในหน้านี้ */
  const [armed, setArmed] = useState("");

  const load = useCallback(async () => {
    try {
      const token = await getToken();
      const r = await fetch("/api/monitor/todo", {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        cache: "no-store",
      });
      // 403 ไม่ใช่ปัญหาการล็อกอิน ล็อกอินใหม่ก็ไม่ได้สิทธิ์เพิ่ม
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

  /* โหลดครั้งแรกต้องเลื่อนออกไปหนึ่ง tick — เรียก setState ตรง ๆ ในตัว effect
     ทำให้ React เรนเดอร์ซ้อนกัน และ lint ของโปรเจกต์ห้ามไว้ */
  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [load]);

  const act = useCallback(
    async (
      tag: string,
      body: Record<string, unknown>,
      done: (d: Record<string, number>) => string
    ) => {
      setBusy(tag);
      setMsg("");
      try {
        const token = await getToken();
        const r = await fetch("/api/monitor/todo", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify(body),
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
        setMsg(done(d));
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

  if (denied) {
    return (
      <div className="mtd">
        <style dangerouslySetInnerHTML={{ __html: CSS }} />
        <div className="center">
          <div className="kick">ไม่มีสิทธิ์</div>
          <div style={{ color: "#8a8a8a", maxWidth: 460, fontSize: 15 }}>
            หน้านี้เปิดให้เฉพาะผู้ที่ได้รับสิทธิ์ «จัดการ To Do» — ขอสิทธิ์ได้ที่ผู้ดูแลระบบ
          </div>
          <a className="link" href="/monitor">
            ← กลับห้องทำงาน
          </a>
        </div>
      </div>
    );
  }

  const users = data?.users || [];
  const groups = data?.groups || [];

  return (
    <div className="mtd">
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <div className="wrap">
        <div className="kick">AI ASSISTANT · TO DO</div>
        <h1>จัดการงานและ Microsoft To Do</h1>
        <div className="sub">
          งานค้างทั้งระบบ {data ? data.total : "—"} งาน · เปิดซิงค์ {users.filter((u) => u.on).length}/
          {users.length} คน ·{" "}
          <a className="link" href="/monitor">
            ห้องทำงาน
          </a>{" "}
          ·{" "}
          <a className="link" href="/monitor/log">
            log
          </a>
        </div>

        <div className="card">
          <h2>รายคน</h2>
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>บัญชี</th>
                  <th>สิทธิ์ To Do</th>
                  <th>ซิงค์</th>
                  <th className="num">งานค้าง</th>
                  <th className="num">การ์ดใน To Do</th>
                  <th>ซิงค์ล่าสุด</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <React.Fragment key={u.upn}>
                  <tr>
                    <td>
                      <button
                        className="plain"
                        onClick={() => setOpenUser((o) => ({ ...o, [u.upn]: !o[u.upn] }))}
                        title="กางดูงานของคนนี้"
                      >
                        {openUser[u.upn] ? "▾" : "▸"} {shortUpn(u.upn)}
                      </button>
                    </td>
                    <td>
                      {u.consent ? (
                        <span className="tag ok">อนุญาตแล้ว</span>
                      ) : u.linked ? (
                        <span className="tag warn">ยังไม่ให้สิทธิ์</span>
                      ) : (
                        <span className="tag off">ยังไม่เชื่อม M365</span>
                      )}
                    </td>
                    <td>
                      <button
                        disabled={!!busy || !u.consent}
                        onClick={() =>
                          void act(
                            `t${u.upn}`,
                            { action: "toggle", upn: u.upn, on: !u.on },
                            () => `${u.on ? "ปิด" : "เปิด"}การซิงค์ของ ${shortUpn(u.upn)} แล้ว`
                          )
                        }
                      >
                        {u.on ? "เปิดอยู่ · กดเพื่อปิด" : "ปิดอยู่ · กดเพื่อเปิด"}
                      </button>
                    </td>
                    <td className="num">{u.tasks}</td>
                    <td className="num">{u.cards}</td>
                    <td style={{ color: "#8a8a8a", fontSize: 13, whiteSpace: "nowrap" }}>
                      {fmtAgo(u.lastSync)}
                    </td>
                    <td>
                      <button
                        disabled={!!busy || !u.on}
                        onClick={() =>
                          void act(
                            `s${u.upn}`,
                            { action: "sync", upn: u.upn },
                            (d) =>
                              `${shortUpn(u.upn)} — เข้า To Do ${d.created ?? 0} · ปิดใน To Do ${
                                d.completedInTodo ?? 0
                              } · ดึงกลับ ${d.importedFromTodo ?? 0}`
                          )
                        }
                      >
                        {busy === `s${u.upn}` ? "กำลังซิงค์…" : "ซิงค์เดี๋ยวนี้"}
                      </button>
                    </td>
                  </tr>
                  {openUser[u.upn] && (
                    <tr>
                      <td colSpan={7} style={{ background: "#101011", padding: "4px 8px 12px" }}>
                        {!u.items.length ? (
                          <div style={{ color: "#8a8a8a", fontSize: 13.5, padding: "6px 2px" }}>
                            ไม่มีงานค้าง
                          </div>
                        ) : (
                          <table className="inner">
                            <thead>
                              <tr>
                                <th>#</th>
                                <th>งาน</th>
                                <th>เข้ามาเมื่อ</th>
                                <th>มาจาก</th>
                                <th>กำหนดส่ง</th>
                                <th>ใน To Do</th>
                                <th />
                              </tr>
                            </thead>
                            <tbody>
                              {u.items.map((it) => (
                                <tr key={it.id}>
                                  <td style={{ color: "#6f6f6f" }}>{it.id}</td>
                                  <td>
                                    {it.title}
                                    {it.responsible && <span className="resp"> · {it.responsible}</span>}
                                    {/* ต้องมี {" "} คั่น ไม่งั้นชื่อผู้รับผิดชอบกับป้ายสถานะติดกันเป็นคำเดียว
                                        ("บอลเกินกำหนด") */}
                                    {it.status === "overdue" && (
                                      <>
                                        {" "}
                                        <span className="tag warn">เกินกำหนด</span>
                                      </>
                                    )}
                                  </td>
                                  <td style={{ whiteSpace: "nowrap" }}>{stamp(it.createdAt)}</td>
                                  <td style={{ maxWidth: 260 }}>{sourceLabel(it.source)}</td>
                                  <td style={{ whiteSpace: "nowrap" }}>{stamp(it.due)}</td>
                                  <td>{it.inTodo ? "✅" : "—"}</td>
                                  <td>
                                    <button
                                      className={`danger${armed === `one${it.id}` ? " armed" : ""}`}
                                      disabled={!!busy}
                                      onClick={() => {
                                        if (armed !== `one${it.id}`) {
                                          setArmed(`one${it.id}`);
                                          return;
                                        }
                                        void act(
                                          `one${it.id}`,
                                          { action: "delete", upn: u.upn, ids: [it.id] },
                                          (d) =>
                                            `ลบงาน #${it.id} แล้ว · การ์ดใน To Do ${d.cardsRemoved ?? 0} ใบ`
                                        );
                                      }}
                                    >
                                      {armed === `one${it.id}` ? "ยืนยันลบ" : "ลบ"}
                                    </button>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                      </td>
                    </tr>
                  )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>
          {msg && <div className="msg">{msg}</div>}
        </div>

        <div className="card">
          <h2>งานค้าง แยกตามที่มา · วัน · เจ้าของ</h2>
          {!groups.length && <div style={{ color: "#8a8a8a", fontSize: 14 }}>ไม่มีงานค้าง</div>}
          {groups.map((g) => (
            <div
              key={g.key}
              style={{ borderTop: "1px solid #202022", paddingTop: 10, marginTop: 10 }}
            >
              <div className="ghead" onClick={() => setOpen((o) => ({ ...o, [g.key]: !o[g.key] }))}>
                <span className="gday">{g.day}</span>
                <span className="gsrc">{g.source}</span>
                <span className="gowner">{shortUpn(g.owner)}</span>
                <span className="gn">{g.n} งาน</span>
                <button
                  className={`danger${armed === g.key ? " armed" : ""}`}
                  disabled={!!busy}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (armed !== g.key) {
                      setArmed(g.key);
                      return;
                    }
                    void act(
                      `d${g.key}`,
                      { action: "delete", upn: g.owner, ids: g.ids },
                      (d) => `ลบ ${d.removed ?? 0} งาน และการ์ดใน To Do ${d.cardsRemoved ?? 0} ใบ`
                    );
                  }}
                >
                  {busy === `d${g.key}`
                    ? "กำลังลบ…"
                    : armed === g.key
                      ? `ยืนยันลบ ${g.n} งาน`
                      : "ลบทั้งกลุ่ม"}
                </button>
              </div>
              {open[g.key] && (
                <ul>
                  {g.items.map((it) => (
                    <li key={it.id}>
                      <span className="id">#{it.id}</span>
                      <span style={{ flex: 1 }}>{it.title}</span>
                      {it.responsible && <span className="resp">{it.responsible}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>

        {err && <div className="msg">{err}</div>}
      </div>
    </div>
  );
}

function Gate() {
  const { account, login, getToken } = useM365Auth();
  if (!account) {
    return (
      <div className="mtd">
        <style dangerouslySetInnerHTML={{ __html: CSS }} />
        <div className="center">
          <div className="kick">AI ASSISTANT · TO DO</div>
          <div style={{ color: "#8a8a8a", fontSize: 15 }}>ต้องล็อกอิน Microsoft 365 เพื่อดูหน้านี้</div>
          <button onClick={() => login()}>เข้าสู่ระบบ M365</button>
        </div>
      </div>
    );
  }
  return <TodoView getToken={getToken} />;
}

export default function MonitorTodoPage() {
  return (
    <M365AuthProvider>
      <Gate />
    </M365AuthProvider>
  );
}
