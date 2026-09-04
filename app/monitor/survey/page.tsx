"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { M365AuthProvider, useM365Auth } from "@/components/M365AuthProvider";
import { ConfirmDialog, type ConfirmSpec } from "@/components/ConfirmDialog";

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
  meta: {
    labels?: Record<string, string>;
    kinds?: Record<string, string>;
    upn?: string | null;
    email?: string | null;
  } | null;
  created_at: string;
};

const DEV = process.env.NODE_ENV !== "production";

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Thai:wght@400;500;600;700&display=swap');
.msv{--bg:#f0f3f6;--card:#fff;--ink:#0f172a;--mute:#64748b;--line:#e2e8f0;--brand:#0f766e;--soft:#ecfdf5;
  --hot:#c2410c;--danger:#b91c1c;font-family:'IBM Plex Sans Thai',system-ui,sans-serif;background:var(--bg);color:var(--ink);min-height:100vh;padding:18px 16px 56px}
.msv *{box-sizing:border-box}
.msv .wrap{max-width:980px;margin:0 auto}
.msv h1{font-size:24px;font-weight:700;margin:0 0 4px;letter-spacing:-.02em}
.msv h2{font-size:15px;font-weight:700;margin:0 0 12px}
.msv .sub{font-size:13px;color:var(--mute);margin-bottom:18px;line-height:1.5}
.msv a{color:var(--brand);text-decoration:none}
.msv .bar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:16px}
.msv .bar .grow{flex:1;min-width:8px}
.msv select,.msv button{font-family:inherit;font-size:13px;padding:8px 14px;border-radius:10px;border:1px solid var(--line);background:#fff;cursor:pointer}
.msv button.primary{background:var(--brand);color:#fff;border-color:var(--brand);font-weight:600}
.msv button.ghost{background:#fff}
.msv button.danger{color:var(--danger);border-color:#fecaca;background:#fff}
.msv button.danger:hover{background:#fef2f2}
.msv button:disabled{opacity:.5;cursor:default}
.msv .live{font-size:12px;color:var(--mute)}
.msv .kpi{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:16px}
@media(max-width:720px){.msv .kpi{grid-template-columns:1fr}}
.msv .kpi .box{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px 16px}
.msv .kpi .lbl{font-size:12px;color:var(--mute);margin-bottom:4px}
.msv .kpi .num{font-size:28px;font-weight:700;color:var(--brand);line-height:1.1}
.msv .kpi .hint{font-size:12.5px;color:var(--ink);margin-top:6px;line-height:1.35;font-weight:500}
.msv .section{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:16px 18px;margin-bottom:14px;box-shadow:0 1px 2px rgba(15,23,42,.04)}
.msv .rank{display:flex;flex-direction:column;gap:10px}
.msv .rank-row{display:grid;grid-template-columns:28px 1fr 52px;gap:10px;align-items:center}
.msv .rank-n{font-size:13px;font-weight:700;color:var(--mute);text-align:right}
.msv .rank-n.top{color:var(--brand)}
.msv .rank-body{min-width:0}
.msv .rank-label{font-size:13.5px;font-weight:600;margin-bottom:4px;line-height:1.35}
.msv .rank-meta{font-size:11.5px;color:var(--mute)}
.msv .track{height:8px;background:#eef2f6;border-radius:999px;overflow:hidden}
.msv .track i{display:block;height:100%;border-radius:999px;background:linear-gradient(90deg,#14b8a6,var(--brand))}
.msv .track.star i{background:linear-gradient(90deg,#fb923c,#ea580c)}
.msv .rank-score{font-size:15px;font-weight:700;color:var(--brand);text-align:right}
.msv .chips{display:flex;flex-wrap:wrap;gap:8px}
.msv .chip{background:#fff7ed;border:1px solid #fed7aa;color:#9a3412;border-radius:999px;padding:6px 12px;font-size:12.5px;font-weight:600}
.msv .chip b{font-weight:700}
.msv .people{display:flex;flex-direction:column;gap:8px}
.msv .person{border:1px solid var(--line);border-radius:12px;padding:12px 14px;background:#fafbfc}
.msv .person-h{display:flex;justify-content:space-between;gap:10px;align-items:flex-start;flex-wrap:wrap}
.msv .person-h strong{font-size:14.5px}
.msv .meta{font-size:12px;color:var(--mute)}
.msv .star-tag{display:inline-block;margin-top:6px;background:#fff7ed;color:#c2410c;border:1px solid #fed7aa;border-radius:8px;padding:3px 8px;font-size:12px;font-weight:600}
.msv .note{background:var(--soft);border-radius:8px;padding:8px 10px;font-size:13px;margin-top:8px}
.msv table{width:100%;border-collapse:collapse;font-size:13px;margin-top:8px}
.msv th{text-align:left;color:var(--mute);font-weight:600;padding:6px 4px;border-bottom:1px solid var(--line)}
.msv td{padding:7px 4px;border-bottom:1px solid #f1f5f9;vertical-align:top}
.msv .score{font-weight:700;color:var(--brand)}
.msv .cmt{font-size:12px;color:#475569}
.msv .empty{color:var(--mute);padding:36px;text-align:center}
.msv .err{background:#fef2f2;color:#b91c1c;border:1px solid #fecaca;border-radius:12px;padding:12px;margin-bottom:12px}
.msv .ok{background:var(--soft);color:#065f46;border:1px solid #a7f3d0;border-radius:12px;padding:12px;margin-bottom:12px}
.msv .center{min-height:50vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;text-align:center}
.msv .tabs{display:flex;gap:6px;margin-bottom:12px;flex-wrap:wrap}
.msv .tabs button{border-radius:999px;padding:6px 12px;font-size:12.5px;font-weight:600}
.msv .tabs button.on{background:var(--brand);color:#fff;border-color:var(--brand)}
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

function csvEscape(s: unknown) {
  const t = String(s ?? "");
  if (/[",\n\r]/.test(t)) return `"${t.replace(/"/g, '""')}"`;
  return t;
}

function downloadCsv(filename: string, lines: string[]) {
  const blob = new Blob(["\uFEFF" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function surveyLabel(id: string) {
  if (id === "line-short-v2") return "ฉบับสั้น v2";
  if (id === "line-full-v2") return "คู่มือเต็ม v2";
  if (!id) return "ทั้งหมด";
  return id;
}

function SurveyAdmin({ getToken }: { getToken: () => Promise<string | null> }) {
  const [rows, setRows] = useState<SurveyRow[]>([]);
  const [total, setTotal] = useState(0);
  const [survey, setSurvey] = useState("line-short-v2");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [okMsg, setOkMsg] = useState("");
  const [denied, setDenied] = useState(false);
  const [liveAt, setLiveAt] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [tab, setTab] = useState<"rank" | "star" | "people">("rank");
  const [ask, setAsk] = useState<ConfirmSpec | null>(null);

  const headers = useCallback(async () => {
    const token = await getToken();
    const h: Record<string, string> = {};
    if (token) h.Authorization = `Bearer ${token}`;
    return h;
  }, [getToken]);

  const load = useCallback(
    async (opts?: { silent?: boolean }) => {
      const silent = !!opts?.silent;
      if (!silent) {
        setBusy(true);
        setErr("");
      }
      try {
        const q = new URLSearchParams({ limit: "200", survey });
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
        setLiveAt(
          new Date().toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
        );
        if (silent) setErr("");
      } catch (e) {
        if (!silent) setErr(String(e).replace(/^Error:\s*/, ""));
      } finally {
        if (!silent) setBusy(false);
      }
    },
    [headers, survey]
  );

  useEffect(() => {
    void load();
    const tick = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void load({ silent: true });
    };
    const id = window.setInterval(tick, 5000);
    const onVis = () => {
      if (document.visibilityState === "visible") void load({ silent: true });
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [load]);

  const avgByFeature = useMemo(() => {
    const sum: Record<string, { n: number; s: number; label: string; hot: number }> = {};
    for (const row of rows) {
      for (const [id, score] of Object.entries(row.answers || {})) {
        if (!sum[id]) sum[id] = { n: 0, s: 0, label: labelOf(row, id), hot: 0 };
        sum[id].n += 1;
        sum[id].s += Number(score) || 0;
        if (Number(score) === 5) sum[id].hot += 1;
        if (!sum[id].label || sum[id].label === id) sum[id].label = labelOf(row, id);
      }
    }
    return Object.entries(sum)
      .map(([id, v]) => ({ id, label: v.label, avg: v.s / v.n, n: v.n, hot: v.hot }))
      .sort((a, b) => b.avg - a.avg || b.n - a.n);
  }, [rows]);

  const starCounts = useMemo(() => {
    const m: Record<string, { n: number; label: string }> = {};
    for (const row of rows) {
      if (!row.star_id) continue;
      if (!m[row.star_id]) m[row.star_id] = { n: 0, label: labelOf(row, row.star_id) };
      m[row.star_id].n += 1;
      if (!m[row.star_id].label || m[row.star_id].label === row.star_id) {
        m[row.star_id].label = labelOf(row, row.star_id);
      }
    }
    const max = Math.max(1, ...Object.values(m).map((x) => x.n));
    return Object.entries(m)
      .map(([id, v]) => ({ id, ...v, pct: (v.n / max) * 100 }))
      .sort((a, b) => b.n - a.n);
  }, [rows]);

  const topAvg = avgByFeature[0];
  const topStar = starCounts[0];
  const maxAvg = Math.max(5, ...avgByFeature.map((f) => f.avg));

  const exportReport = () => {
    if (!rows.length) {
      setErr("ยังไม่มีข้อมูลให้ export");
      return;
    }
    const stamp = new Date().toISOString().slice(0, 10);
    const summary = [
      ["รายงานผลสำรวจ LINE", surveyLabel(survey)].map(csvEscape).join(","),
      ["ส่งออกเมื่อ", new Date().toLocaleString("th-TH", { timeZone: "Asia/Bangkok" })].map(csvEscape).join(","),
      ["จำนวนผู้ตอบ", String(total)].map(csvEscape).join(","),
      "",
      ["อันดับ", "ฟังก์ชัน", "คะแนนเฉลี่ย", "n", "ให้ 5 คะแนน"].map(csvEscape).join(","),
      ...avgByFeature.map((f, i) =>
        [i + 1, f.label, f.avg.toFixed(2), f.n, f.hot].map(csvEscape).join(",")
      ),
      "",
      ["ดาว — อยากให้ทำก่อน", "ครั้ง"].map(csvEscape).join(","),
      ...starCounts.map((s) => [s.label, s.n].map(csvEscape).join(",")),
      "",
      [
        "เวลา",
        "ชื่อ",
        "ฝ่าย",
        "ตำแหน่ง",
        "UPN",
        "อีเมล",
        "แบบสำรวจ",
        "ดาว-ทำก่อน",
        "ฟังก์ชัน",
        "คะแนน",
        "ความเห็นข้อ",
        "ข้อเสนอแนะรวม",
      ]
        .map(csvEscape)
        .join(","),
    ];

    const detail: string[] = [];
    for (const row of rows) {
      const starLabel = row.star_id ? labelOf(row, row.star_id) : "";
      const entries = Object.entries(row.answers || {});
      if (!entries.length) {
        detail.push(
          [
            fmtWhen(row.created_at),
            row.name || "",
            row.dept || "",
            row.role_title || "",
            row.meta?.upn || "",
            row.meta?.email || "",
            row.survey_id,
            starLabel,
            "",
            "",
            "",
            row.note || "",
          ]
            .map(csvEscape)
            .join(",")
        );
        continue;
      }
      for (const [id, score] of entries) {
        detail.push(
          [
            fmtWhen(row.created_at),
            row.name || "",
            row.dept || "",
            row.role_title || "",
            row.meta?.upn || "",
            row.meta?.email || "",
            row.survey_id,
            starLabel,
            labelOf(row, id),
            score,
            row.comments?.[id] || "",
            row.note || "",
          ]
            .map(csvEscape)
            .join(",")
        );
      }
    }

    downloadCsv(`survey-report-${survey || "all"}-${stamp}.csv`, [...summary, ...detail]);
    setOkMsg("ดาวน์โหลดรายงาน CSV แล้ว");
    setTimeout(() => setOkMsg(""), 3000);
  };

  const clearData = () => {
    const scope = surveyLabel(survey);
    setAsk({
      title: "ล้างข้อมูลผลสำรวจ",
      target: scope,
      lines: [
        survey
          ? `จะลบคำตอบทั้งหมดของแบบ ${scope} ที่ส่งเข้ามาแล้ว`
          : "จะลบคำตอบทุกแบบสำรวจที่ส่งเข้ามาแล้ว",
        "กู้คืนไม่ได้หลังยืนยัน",
        `ตอนนี้มี ${total} รายการ`,
      ],
      confirmLabel: "ยืนยันล้างผลสำรวจ",
      danger: true,
      onConfirm: () => {
        setAsk(null);
        void (async () => {
          setBusy(true);
          setErr("");
          try {
            const q = new URLSearchParams({ confirm: "ล้างผลสำรวจ", survey });
            const r = await fetch(`/api/survey/responses?${q}`, {
              method: "DELETE",
              headers: await headers(),
            });
            const d = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
            setOkMsg(`ล้างแล้ว ${d.deleted ?? 0} รายการ`);
            setTimeout(() => setOkMsg(""), 4000);
            await load();
          } catch (e) {
            setErr(String(e).replace(/^Error:\s*/, ""));
          } finally {
            setBusy(false);
          }
        })();
      },
    });
  };

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
      <ConfirmDialog spec={ask} onCancel={() => setAsk(null)} />
      <div className="wrap">
        <h1>รายงานผลสำรวจ LINE</h1>
        <p className="sub">
          สรุปสิ่งที่อยากได้มากที่สุดจากพนักงาน ·{" "}
          <a href="/survey" target="_blank" rel="noreferrer">
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
          <button type="button" className="ghost" onClick={exportReport} disabled={!rows.length}>
            Export report
          </button>
          <button type="button" className="danger" onClick={clearData} disabled={busy || !total}>
            ล้างข้อมูล
          </button>
          <span className="grow" />
          <span className="live">อัปเดตอัตโนมัติ{liveAt ? ` · ${liveAt}` : ""}</span>
        </div>

        {err ? <div className="err">{err}</div> : null}
        {okMsg ? <div className="ok">{okMsg}</div> : null}

        <div className="kpi">
          <div className="box">
            <div className="lbl">ผู้ตอบแล้ว</div>
            <div className="num">{total}</div>
            <div className="hint">แสดง {rows.length} รายการล่าสุด</div>
          </div>
          <div className="box">
            <div className="lbl">อยากให้ทำก่อน (ดาว)</div>
            <div className="num">{topStar ? topStar.n : 0}</div>
            <div className="hint" title={topStar?.label}>
              {topStar?.label || "ยังไม่มีใครเลือกดาว"}
            </div>
          </div>
          <div className="box">
            <div className="lbl">คะแนนเฉลี่ยสูงสุด</div>
            <div className="num">{topAvg ? topAvg.avg.toFixed(1) : "—"}</div>
            <div className="hint" title={topAvg?.label}>
              {topAvg?.label || "ยังไม่มีคะแนน"}
            </div>
          </div>
        </div>

        <div className="section">
          <div className="tabs">
            <button type="button" className={tab === "rank" ? "on" : ""} onClick={() => setTab("rank")}>
              อันดับคะแนน
            </button>
            <button type="button" className={tab === "star" ? "on" : ""} onClick={() => setTab("star")}>
              ดาว — ทำก่อน
            </button>
            <button type="button" className={tab === "people" ? "on" : ""} onClick={() => setTab("people")}>
              ผู้ตอบ ({rows.length})
            </button>
          </div>

          {tab === "rank" ? (
            !avgByFeature.length ? (
              <div className="empty">ยังไม่มีคะแนน</div>
            ) : (
              <div className="rank">
                {avgByFeature.map((f, i) => (
                  <div className="rank-row" key={f.id}>
                    <div className={`rank-n${i < 3 ? " top" : ""}`}>{i + 1}</div>
                    <div className="rank-body">
                      <div className="rank-label">{f.label}</div>
                      <div className="track">
                        <i style={{ width: `${Math.max(4, (f.avg / maxAvg) * 100)}%` }} />
                      </div>
                      <div className="rank-meta">
                        จาก {f.n} คน · ให้ 5 เต็ม {f.hot} คน
                      </div>
                    </div>
                    <div className="rank-score">{f.avg.toFixed(2)}</div>
                  </div>
                ))}
              </div>
            )
          ) : null}

          {tab === "star" ? (
            !starCounts.length ? (
              <div className="empty">ยังไม่มีใครเลือกดาว</div>
            ) : (
              <>
                <div className="chips" style={{ marginBottom: 14 }}>
                  {starCounts.slice(0, 5).map((s) => (
                    <span className="chip" key={s.id}>
                      ⭐ {s.label} <b>×{s.n}</b>
                    </span>
                  ))}
                </div>
                <div className="rank">
                  {starCounts.map((s, i) => (
                    <div className="rank-row" key={s.id}>
                      <div className={`rank-n${i < 3 ? " top" : ""}`}>{i + 1}</div>
                      <div className="rank-body">
                        <div className="rank-label">{s.label}</div>
                        <div className="track star">
                          <i style={{ width: `${Math.max(6, s.pct)}%` }} />
                        </div>
                      </div>
                      <div className="rank-score">{s.n}</div>
                    </div>
                  ))}
                </div>
              </>
            )
          ) : null}

          {tab === "people" ? (
            !rows.length ? (
              <div className="empty">ยังไม่มีคำตอบที่ส่งมา</div>
            ) : (
              <div className="people">
                {rows.map((row) => {
                  const open = openId === row.id;
                  const entries = Object.entries(row.answers || {}).sort(
                    (a, b) => Number(b[1]) - Number(a[1])
                  );
                  return (
                    <div className="person" key={row.id}>
                      <div className="person-h">
                        <div>
                          <strong>{row.name || "(ไม่ระบุชื่อ)"}</strong>
                          <div className="meta">
                            {[row.dept, row.role_title].filter(Boolean).join(" · ") || "—"}
                            {row.meta?.upn || row.meta?.email
                              ? ` · ${row.meta.upn || row.meta.email}`
                              : ""}
                          </div>
                          {row.star_id ? (
                            <div className="star-tag">⭐ ทำก่อน: {labelOf(row, row.star_id)}</div>
                          ) : null}
                        </div>
                        <div className="meta" style={{ textAlign: "right" }}>
                          {fmtWhen(row.created_at)}
                          <div style={{ marginTop: 6 }}>
                            <button type="button" onClick={() => setOpenId(open ? null : row.id)}>
                              {open ? "ซ่อน" : "รายละเอียด"}
                            </button>
                          </div>
                        </div>
                      </div>
                      {row.note ? <div className="note">💬 {row.note}</div> : null}
                      {open ? (
                        <table>
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
                          ตอบ {entries.length} ข้อ
                          {entries[0]
                            ? ` · สูงสุด ${labelOf(row, entries[0][0])} (${entries[0][1]})`
                            : ""}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )
          ) : null}
        </div>
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
          <h1>เข้าสู่ระบบเพื่อดูรายงาน</h1>
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
