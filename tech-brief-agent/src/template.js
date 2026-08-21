// Builds the daily-brief infographic as a single self-contained HTML string.
// render.js rasterises the #card element to PNG, so height is fully dynamic.
// Design system: KTIS X — near-black canvas, off-white type, one hot red,
// Kanit, film grain, a single red aura, brutalist hairlines + oversized indices.

const C = {
  bg: "#0a0a0a",
  raised: "#111111",
  ink: "#f5f5f5",
  muted: "#8a8a8a",
  faint: "#2e2e2e",
  red: "#ee1b24",
  redDeep: "#b3121a",
  hair: "rgba(255,255,255,0.08)",
  body: "#c4c4c4",
};

const KTIS_MARK = `<svg viewBox="0 0 100 100" width="52" height="52" fill="none" aria-hidden="true">
  <g stroke="${C.red}" stroke-width="17" stroke-linecap="butt">
    <line x1="24" y1="20" x2="82" y2="86"/><line x1="22" y1="86" x2="74" y2="28"/>
  </g><polygon points="89,11 63.6,18.7 84.4,37.3" fill="${C.red}"/>
</svg>`;

const GRAIN =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E";

const esc = (s = "") =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

function dateLabel(date, tz = "Asia/Bangkok") {
  try {
    return new Intl.DateTimeFormat("th-TH-u-ca-gregory", {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: tz,
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

function storyRow(s, i) {
  const n = String(i + 1).padStart(2, "0");
  return `
  <article class="story">
    <div class="idx">${n}</div>
    <div class="body">
      <span class="chip">${esc(s.category)}</span>
      <h2 class="head">${esc(s.headline_th)}</h2>
      <p class="sum">${esc(s.summary_th)}</p>
      <div class="src"><span class="tick"></span>${esc(s.source_name)}</div>
    </div>
  </article>`;
}

export function buildHtml(stories, meta = {}) {
  const date = meta.date instanceof Date ? meta.date : new Date();
  const count = stories.length;
  const label = dateLabel(date, meta.tz);

  return `<!DOCTYPE html>
<html lang="th"><head><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Kanit:wght@300;400;600;800;900&family=JetBrains+Mono:wght@500;700&display=swap" rel="stylesheet">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:${C.bg}; }
  #card {
    position:relative; width:1080px; background:${C.bg}; color:${C.ink};
    font-family:'Kanit',system-ui,sans-serif; overflow:hidden; padding:72px 76px 56px;
  }
  .aura { position:absolute; top:-260px; right:-180px; width:720px; height:720px;
    background:radial-gradient(circle, rgba(238,27,36,0.28), transparent 68%);
    filter:blur(40px); pointer-events:none; z-index:0; }
  .grain { position:absolute; inset:0; background-image:url("${GRAIN}");
    opacity:0.05; mix-blend-mode:overlay; pointer-events:none; z-index:2; }
  #card > * { position:relative; z-index:3; }

  /* header */
  header { display:flex; flex-direction:column; gap:18px; }
  .eyebrow { font-family:'JetBrains Mono',monospace; font-weight:700; font-size:14px;
    letter-spacing:0.34em; text-transform:uppercase; color:${C.muted}; }
  .brandrow { display:flex; align-items:center; gap:22px; }
  .wordmark { font-weight:900; font-size:82px; line-height:0.9; letter-spacing:-0.03em; }
  .wordmark em { color:${C.red}; font-style:normal; }
  .metarow { display:flex; align-items:baseline; justify-content:space-between; gap:20px; }
  .date { font-size:23px; font-weight:400; color:${C.body}; }
  .count { font-family:'JetBrains Mono',monospace; font-weight:700; font-size:15px;
    letter-spacing:0.12em; color:${C.muted}; white-space:nowrap; }
  .count b { color:${C.red}; font-size:18px; }
  .rule { height:5px; background:${C.red}; margin:26px 0 4px; width:100%; }

  /* stories */
  .story { display:flex; gap:30px; padding:34px 0 30px; border-bottom:1px solid ${C.hair}; }
  .story:last-of-type { border-bottom:none; }
  .idx { font-weight:900; font-size:62px; line-height:0.9; color:transparent;
    -webkit-text-stroke:1.5px ${C.faint}; min-width:96px; letter-spacing:-0.04em; }
  .body { flex:1; }
  .chip { display:inline-block; font-family:'JetBrains Mono',monospace; font-weight:700;
    font-size:12px; letter-spacing:0.18em; text-transform:uppercase; color:${C.red};
    border:1.5px solid ${C.red}; padding:4px 11px 3px; margin-bottom:14px; }
  .head { font-weight:800; font-size:31px; line-height:1.18; letter-spacing:-0.01em;
    color:${C.ink}; margin-bottom:11px; }
  .sum { font-weight:300; font-size:19.5px; line-height:1.62; color:${C.body}; }
  .src { display:flex; align-items:center; gap:9px; margin-top:15px;
    font-family:'JetBrains Mono',monospace; font-weight:700; font-size:13.5px;
    letter-spacing:0.06em; color:${C.ink}; }
  .tick { width:4px; height:15px; background:${C.red}; display:inline-block; }

  /* footer */
  footer { display:flex; justify-content:space-between; align-items:center;
    margin-top:40px; padding-top:22px; border-top:1px solid ${C.hair};
    font-family:'JetBrains Mono',monospace; font-weight:500; font-size:12.5px;
    letter-spacing:0.1em; color:${C.faint}; text-transform:uppercase; }
  footer .r { color:${C.muted}; }
</style></head>
<body>
  <div id="card">
    <div class="aura"></div>
    <div class="grain"></div>

    <header>
      <div class="eyebrow">รายงานข่าว Tech &amp; AI ประจำวัน</div>
      <div class="brandrow">${KTIS_MARK}<div class="wordmark">TECH&nbsp;<em>BRIEF</em></div></div>
      <div class="metarow">
        <div class="date">${esc(label)}</div>
        <div class="count">TODAY&nbsp;<b>${count}</b>&nbsp;STORIES</div>
      </div>
      <div class="rule"></div>
    </header>

    <main>
      ${stories.map(storyRow).join("")}
    </main>

    <footer>
      <span>สร้างอัตโนมัติด้วย Claude · Agentic web-search</span>
      <span class="r">KTIS&nbsp;X</span>
    </footer>
  </div>
</body></html>`;
}
