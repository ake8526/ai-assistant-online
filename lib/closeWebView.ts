/** Prepare + close LINE in-app browser / LIFF webview after setup. */
const LIFF_ID = process.env.NEXT_PUBLIC_LIFF_ID || "2010856732-BFseuR2p";

type LiffApi = {
  init: (c: { liffId: string }) => Promise<void>;
  isInClient: () => boolean;
  closeWindow?: () => void;
};

function liffWin(): Window & { liff?: LiffApi } {
  return window as Window & { liff?: LiffApi };
}

function loadLiffSdk(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (liffWin().liff) return resolve();
    const s = document.createElement("script");
    s.src = "https://static.line-scdn.net/liff/edge/2/sdk.js";
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("LIFF SDK load failed"));
    document.head.appendChild(s);
  });
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
  ]);
}

let preparePromise: Promise<void> | null = null;

export function prepareWebViewClose(): Promise<void> {
  if (!preparePromise) {
    preparePromise = (async () => {
      try {
        await loadLiffSdk();
        const liff = liffWin().liff;
        if (liff && LIFF_ID) await withTimeout(liff.init({ liffId: LIFF_ID }), 3000);
      } catch {
        /* ok on external URL */
      }
    })();
  }
  return preparePromise.catch(() => undefined);
}

/** Instant overlay — runs synchronously on button tap. */
export function showDoneOverlay(): void {
  if (typeof document === "undefined" || document.getElementById("setup-done-overlay")) return;
  const el = document.createElement("div");
  el.id = "setup-done-overlay";
  el.style.cssText =
    "position:fixed;inset:0;z-index:99999;background:#020617;display:flex;align-items:center;justify-content:center;text-align:center;padding:24px;font-family:system-ui,sans-serif";
  el.innerHTML =
    '<div><div style="font-size:3rem;margin-bottom:12px">✅</div>' +
    '<p style="font-size:1.125rem;font-weight:700;color:#f1f5f9;margin:0 0 8px">เสร็จแล้ว</p>' +
    '<p style="font-size:0.875rem;color:#94a3b8;line-height:1.6;margin:0">กำลังปิดหน้าต่าง…<br><span style="font-size:0.75rem">ถ้าไม่ปิด กด <b style="color:#f1f5f9">✕</b> มุมบนขวา</span></p></div>';
  document.body.appendChild(el);
}

export function showManualCloseHint(): void {
  showDoneOverlay();
  const p = document.querySelector("#setup-done-overlay p:last-child");
  if (p) {
    p.innerHTML = 'กด <b style="color:#f1f5f9">✕</b> มุมบนขวา<br>เพื่อกลับแชท LINE';
  }
}

function tryLiffClose(): boolean {
  try {
    const liff = liffWin().liff;
    if (liff?.closeWindow) {
      liff.closeWindow();
      return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

function tryFallbackClose(): boolean {
  try {
    if (window.history.length > 1) {
      window.history.back();
      return true;
    }
  } catch {
    /* ignore */
  }
  const ua = navigator.userAgent || "";
  try {
    if (/Android/i.test(ua)) {
      window.location.href =
        "intent://line.me#Intent;scheme=line;package=jp.naver.line.android;end";
      return true;
    }
    window.location.href = "line://nv/chat";
    return true;
  } catch {
    /* ignore */
  }
  return false;
}

export async function closeWebView(): Promise<boolean> {
  showDoneOverlay();

  if (tryLiffClose()) return true;

  try {
    await withTimeout(prepareWebViewClose(), 1500);
  } catch {
    /* continue */
  }

  if (tryLiffClose()) return true;
  if (tryFallbackClose()) return true;

  return false;
}
