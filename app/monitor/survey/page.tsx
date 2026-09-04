"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { M365AuthProvider, useM365Auth } from "@/components/M365AuthProvider";

type SurveyRow = {
  id: string;
  survey_id: string;
  name: string | null;
  dept: string | null;
  role_title: string | null;
  note: string | null;
  star_id: string | null;
  answers: Record<string, number>;
  comments: Record<string, string>;
  meta: { labels?: Record<string, string>; kinds?: Record<string, string> } | null;
  created_at: string;
};

const DEV = process.env.NODE_ENV !== "production";

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Thai:wght@400;500;600;700&display=swap');
.msv{--bg:#f2f2f7;--card:#fff;--ink:#1c1c1e;--mute:#8e8e93;--line:#e5e5ea;--brand:#0f766e;--soft:#e0f2f1;
  font-family:'IBM Plex Sans Thai',system-ui,sans-serif;background:var(--bg);color:var(--ink);min-height:100vh;padding:16px 16px 48px}
.msv *{box-sizing:border-box}
.msv .wrap{max-width:1100px;margin:0 auto}
.msv h1{font-size:22px;font-weight:700;margin:0 0 6px}
.msv .sub{font-size:13px;color:var(--mute);margin-bottom:16px}
.msv a{color:var(--brand);text-decoration:none}
.msv .bar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:14px}
.msv select,.msv button{font-family:inherit;font-size:13px;padding:8px 12px;border-radius:10px;border:1px solid var(--line);background:#fff;cursor:pointer}
.msv button.primary{background:var(--brand);color:#fff;border-color:var(--brand);font-weight:600}
.msv button:disabled{opacity:.5;cursor:default}
.msv .stat{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px}
.msv .pill{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:10px 14px;font-size:13px}
.msv .pill b{display:block;font-size:20px;font-weight:700;color:var(--brand)}
.msv .card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px 16px;margin-bottom:12px;box-shadow:0 1px 2px rgba(0,0,0,.04)}
.msv .who{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:8px}
.msv .who strong{font-size:15px}
.msv .meta{font-size:12px;color:var(--mute)}
.msv .star{display:inline-block;background:#fff7ed;color:#c2410c;border:1px solid #fed7aa;border-radius:999px;padding:2px 8px;font-size:11px;font-weight:700;margin-top:4px}
.msv table{width:100%;border-collapse:collapse;font-size:13px}
.msv th{text-align:left;color:var(--mute);font-weight:600;padding:6px 4px;border-bottom:1px solid var(--line)}
.msv td{padding:7px 4px;border-bottom:1px solid #f1f5f9;vertical-align:top}
.msv .score{font-weight:700;color:var(--brand)}
.msv .cmt{font-size:12px;color:#475569;margin-top:2px}
.msv .note{background:var(--soft);border-radius:10px;padding:8px 10px;font-size:13px;margin-top:8px}
.msv .empty{color:var(--mute);padding:28px;text-align:center}
.msv .err{background:#fef2f2;color:#b91c1c;border:1px solid #fecaca;border-radius:12px;padding:12px;margin-bottom:12px}
.msv .center{min-height:50vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;text-align:center}
`;

function fmtWhen(iso: string) {
  try {
    return new Date(iso).toLocaleString("th-TH", { timeZone: "Asia/Bangkok" });
  } catch {
    return iso;
  }
}

function labelOf(row: SurveyRow, id: string) {
  return row.meta?.labels?.[id] || id;
}

function SurveyAdmin({ getToken }: { getToken: () => Promise<string | null> }) {
  const [rows, setRows] = useState<SurveyRow[]>([]);
  const [total, setTotal] = useState(0);
  const [survey, setSurvey] = useState("line-short-v2");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [denied, setDenied] = useState(false);
  const [note, setNote] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);

  const headers = useCallback(async () => {
    const token = await getToken();
    const h: Record<string, string> = {};
    if (token) h.Authorization = `Bearer ${token}`;
    return h;
  }, [getToken]);

  const load = useCallback(async () => {
    setBusy(true);
    setErr("");
    try {
      const q = new URLSearchParams({ limit: "100", survey });
      const r = await fetch(`/api/survey/responses?${q}`, { headers: await headers(), cache: "no-store" });
      if (r.status === 401 || r.status === 403) {
        setDenied(true);
        return;
      }
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setDenied(false);
      setRows(d.rows || []);
      setTotal(d.total || 0);
      setNote(d.note || "");
    } catch (e) {
      setErr(String(e).replace(/^Error:\s*/, ""));
    } finally {
      setBusy(false);
    }
  }, [headers, survey]);

  useEffect(() => {
    void load();
  }, [load]);

  const avgByFeature = useMemo(() => {
    const sum: Record<string, { n: number; s: number; label: string }> = {};
    for (const row of rows) {
      for (const [id, score] of Object.entries(row.answers || {})) {
        if (!sum[id]) sum[id] = { n: 0, s: 0, label: labelOf(row, id) };
        sum[id].n += 1;
        sum[id].s += Number(score) || 0;
        if (!sum[id].label || sum[id].label === id) sum[id].label = labelOf(row, id);
      }
    }
    return Object.entries(sum)
      .map(([id, v]) => ({ id, label: v.label, avg: v.s / v.n, n: v.n }))
      .sort((a, b) => b.avg - a.avg);
  }, [rows]);

  const starCounts = useMemo(() => {
    const m: Record<string, { n: number; label: string }> = {};
    for (const row of rows) {
      if (!row.star_id) continue;
      if (!m[row.star_id]) m[row.star_id] = { n: 0, label: labelOf(row, row.star_id) };
      m[row.star_id].n += 1;
    }
    return Object.entries(m)
      .map(([id, v]) => ({ id, ...v }))
      .sort((a, b) => b.n - a.n);
  }, [rows]);

  if (denied) {
    return (
      <div className="msv">
        <style dangerouslySetInnerHTML={{ __html: CSS }} />
        <div className="center">
          <h1>ไม่มีสิทธิ์ดูผลสำรวจ</h1>
          <p className="sub">ต้องมีสิทธิ์ “ดูผลสำรวจ LINE” — ขอจากผู้ดูแลที่หน้า /monitor/admin</p>
          <a href="/monitor">← ห้องทำงาน</a>
        </div>
      </div>
    );
  }

  return (
    <div className="msv">
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <div className="wrap">
        <h1>ผลสำรวจฟังก์ชัน LINE</h1>
        <p className="sub">
          คำตอบที่พนักงานกดส่งจากแบบสำรวจ ·{" "}
          <a href="/survey-line-v2.html" target="_blank" rel="noreferrer">
            เปิดแบบสำรวจ
          </a>{" "}
          · <a href="/monitor">ห้องทำงาน</a> · <a href="/monitor/admin">สิทธิ์</a>
        </p>

        <div className="bar">
          <select value={survey} onChange={(e) => setSurvey(e.target.value)}>
            <option value="line-short-v2">ฉบับสั้น v2</option>
            <option value="line-full-v2">คู่มือเต็ม v2</option>
            <option value="">ทั้งหมด</option>
          </select>
          <button type="button" className="primary" onClick={() => void load()} disabled={busy}>
            {busy ? "กำลังโหลด…" : "รีเฟรช"}
          </button>
        </div>

        {err ? <div className="err">{err}</div> : null}
        {note ? <div className="err">{note}</div> : null}

        <div className="stat">
          <div className="pill">
            <b>{total}</b>
            จำนวนที่ส่งมา
          </div>
          <div className="pill">
            <b>{rows.length}</b>
            แสดงในหน้านี้
          </div>
          <div className="pill">
            <b>{starCounts[0]?.label?.slice(0, 18) || "—"}</b>
            ดาวสูงสุด ({starCounts[0]?.n || 0})
          </div>
        </div>

        {avgByFeature.length ? (
          <div className="card">
            <strong>คะแนนเฉลี่ยต่อฟังก์ชัน (จากที่โหลดมา)</strong>
            <table style={{ marginTop: 8 }}>
              <thead>
                <tr>
                  <th>ฟังก์ชัน</th>
                  <th>เฉลี่ย</th>
                  <th>n</th>
                </tr>
              </thead>
              <tbody>
                {avgByFeature.slice(0, 20).map((f) => (
                  <tr key={f.id}>
                    <td>{f.label}</td>
                    <td className="score">{f.avg.toFixed(2)}</td>
                    <td>{f.n}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        {!rows.length && !busy ? <div className="empty">ยังไม่มีคำตอบที่ส่งมา</div> : null}

        {rows.map((row) => {
          const open = openId === row.id;
          const entries = Object.entries(row.answers || {}).sort((a, b) => Number(b[1]) - Number(a[1]));
          return (
            <div className="card" key={row.id}>
              <div className="who">
                <div>
                  <strong>{row.name || "(ไม่ระบุชื่อ)"}</strong>
                  <div className="meta">
                    {[row.dept, row.role_title].filter(Boolean).join(" · ") || "—"} · {row.survey_id}
                  </div>
                  {row.star_id ? (
                    <div className="star">⭐ ทำก่อน: {labelOf(row, row.star_id)}</div>
                  ) : null}
                </div>
                <div className="meta" style={{ textAlign: "right" }}>
                  {fmtWhen(row.created_at)}
                  <div>
                    <button type="button" onClick={() => setOpenId(open ? null : row.id)}>
                      {open ? "ซ่อนรายละเอียด" : "ดูรายละเอียด"}
                    </button>
                  </div>
                </div>
              </div>
              {row.note ? <div className="note">💬 {row.note}</div> : null}
              {open ? (
                <table style={{ marginTop: 10 }}>
                  <thead>
                    <tr>
                      <th>ฟังก์ชัน</th>
                      <th>คะแนน</th>
                      <th>ความเห็น</th>
                    </tr>
                  </thead>
                  <tbody>
                    {entries.map(([id, score]) => (
                      <tr key={id}>
                        <td>
                          {row.star_id === id ? "⭐ " : ""}
                          {labelOf(row, id)}
                        </td>
                        <td className="score">{score}</td>
                        <td>
                          <div className="cmt">{row.comments?.[id] || ""}</div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div className="meta" style={{ marginTop: 6 }}>
                  ตอบ {entries.length} ข้อ · คะแนนสูงสุด {entries[0] ? `${labelOf(row, entries[0][0])} (${entries[0][1]})` : "—"}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Gate() {
  const { ready, account, login, getToken } = useM365Auth();
  if (!ready) {
    return (
      <div className="msv">
        <style dangerouslySetInnerHTML={{ __html: CSS }} />
        <div className="center">กำลังโหลด…</div>
      </div>
    );
  }
  if (!account && !DEV) {
    return (
      <div className="msv">
        <style dangerouslySetInnerHTML={{ __html: CSS }} />
        <div className="center">
          <h1>เข้าสู่ระบบเพื่อดูผลสำรวจ</h1>
          <button type="button" className="primary" onClick={() => void login()}>
            เข้าสู่ระบบ Microsoft 365
          </button>
        </div>
      </div>
    );
  }
  return <SurveyAdmin getToken={getToken} />;
}

export default function SurveyMonitorPage() {
  return (
    <M365AuthProvider>
      <Gate />
    </M365AuthProvider>
  );
}
