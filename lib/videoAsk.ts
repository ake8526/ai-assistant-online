/**
 * ส่งลิงก์คลิปหรือช่อง YouTube มาแล้วให้เล่าให้ฟัง
 *
 * ทำไมไม่ใช้ทางเดิมใน lib/youtube.ts: ทางนั้นสรุปจาก "ซับไตเติล" ที่ดึงมาเอง
 * ซึ่งใช้ไม่ได้แล้ว — วัดเมื่อ 10 ก.ย. 2569 จากเซิร์ฟเวอร์:
 *   /api/timedtext?type=list  → 0 tracks (ปลายทางเก่าตายแล้ว)
 *   baseUrl ที่หน้า watch ให้มา → HTTP 200 แต่เนื้อหาว่างเปล่า ทุกฟอร์แมต
 * YouTube ผูกการดึงซับไว้กับเซสชันผู้เล่นจริง ยิงจากเซิร์ฟเวอร์จึงได้ค่าว่าง
 * แปลว่าสรุปคลิปในข่าวเช้าทุกวันนี้ อ่านได้แค่คำบรรยายใต้คลิป ไม่ใช่เนื้อคลิป
 *
 * ทางนี้ให้ Gemini ดูคลิปเองผ่าน file_data ซึ่งเป็นความสามารถทางการของ Gemini
 * วัดจริงกับคลิป ~10 นาที: 3.1-flash-lite ใช้ 8 วิ 32,341 โทเค็น ≈ 0.29 บาท
 * และเล่าได้ถูกต้องระดับระบุชื่อคนในคลิป
 *
 * ข้อจำกัดที่ต้องรู้: Gemini เข้าถึงได้เฉพาะคลิป "สาธารณะ" — คลิปเฉพาะสมาชิก
 * คลิปส่วนตัว หรือคลิปที่จำกัดอายุ จะอ่านไม่ได้ และไม่มีทางใช้สิทธิ์ของผู้ใช้
 * ไปปลดล็อกให้ (ดู AGENTS/บันทึกการคุย 9 ก.ย. 2569)
 */
import { trace } from "@/lib/trace";
import { recordUsage } from "@/lib/llmUsage";

const MODELS = [process.env.GEMINI_VIDEO_MODEL || "gemini-3.1-flash-lite", "gemini-flash-latest"];
const TIMEOUT_MS = Number(process.env.GEMINI_VIDEO_TIMEOUT_MS || 120_000);

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

export type YtTarget =
  | { kind: "video"; videoId: string; url: string }
  | { kind: "channel"; url: string };

/**
 * อ่านข้อความแล้วบอกว่าเขาส่งคลิปมาหรือส่งช่องมา
 *
 * จงใจไม่จับข้อความที่มีคำสั่งของงานอื่นปนอยู่ ("แนบลิงก์นัด", "เพิ่มแหล่งข่าว",
 * "ติดตามเพจ") เพราะลิงก์ YouTube ก็เป็นลิงก์เหมือนกัน ถ้าไม่กันไว้ คนพิมพ์
 * "เพิ่มแหล่งข่าว <ลิงก์ยูทูบ>" จะได้สรุปคลิปแทนที่จะได้เพิ่มแหล่งข่าว
 */
export function parseYouTubeTarget(text: string): YtTarget | null {
  const t = (text || "").trim();
  if (!t) return null;
  if (/แนบ|เพิ่มแหล่ง|ติดตามเพจ|เพิ่ม\s*rss|แก้ชื่อแหล่ง|เปลี่ยนลิงก์|ลบแหล่ง/i.test(t)) return null;

  const m = t.match(/https?:\/\/(?:www\.|m\.)?(?:youtube\.com|youtu\.be)\/\S+/i);
  if (!m) return null;
  const url = m[0].replace(/[)\]},.!?"'»]+$/, "");

  const vid =
    url.match(/[?&]v=([\w-]{11})/)?.[1] ||
    url.match(/youtu\.be\/([\w-]{11})/)?.[1] ||
    url.match(/\/(?:shorts|live|embed)\/([\w-]{11})/)?.[1] ||
    "";
  if (vid) return { kind: "video", videoId: vid, url: `https://www.youtube.com/watch?v=${vid}` };

  if (/youtube\.com\/(?:@|c\/|channel\/|user\/)/i.test(url)) return { kind: "channel", url };
  return null;
}

async function getPage(url: string, timeoutMs = 15_000): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, "Accept-Language": "th,en;q=0.9" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.text();
}

/**
 * คลิปล่าสุดของช่อง
 *
 * ไม่ใช้ RSS ของ YouTube (feeds/videos.xml) เพราะทดสอบจากเซิร์ฟเวอร์นี้ 7 ครั้ง
 * ได้ 200 แค่ครั้งเดียว นอกนั้น 404/500 — อ่านหน้า /videos ของช่องแทน ซึ่งได้
 * รายการคลิปเรียงใหม่สุดมาก่อนอยู่แล้ว และไม่ต้องใช้คีย์หรือสิทธิ์ของใคร
 */
export async function latestVideoOfChannel(
  channelUrl: string
): Promise<{ videoId: string; title: string; channel: string } | null> {
  const base = channelUrl.replace(/\/+$/, "").replace(/\/(videos|featured|streams|shorts)$/i, "");
  const html = await getPage(`${base}/videos`);
  const ids = [...new Set([...html.matchAll(/"videoId":"([\w-]{11})"/g)].map((x) => x[1]!))];
  if (!ids.length) return null;
  const channel =
    html.match(/<meta property="og:title" content="([^"]+)"/)?.[1] ||
    html.match(/"channelMetadataRenderer":\{"title":"([^"]+)"/)?.[1] ||
    "";
  /* ชื่อคลิปหาแบบเบา ๆ จากหน้าเดียวกัน ถ้าไม่เจอก็ไม่เป็นไร Gemini เล่าเนื้อหาให้อยู่แล้ว
     โครง JSON ของ YouTube วาง title ไว้ "ก่อน" videoId ในบางเลย์เอาต์ จึงมองทั้งสองทาง */
  const idx = html.indexOf(`"videoId":"${ids[0]}"`);
  const around = idx >= 0 ? html.slice(Math.max(0, idx - 1200), idx + 1200) : "";
  const title =
    around.match(/"title":\{"runs":\[\{"text":"([^"]{2,160})"/)?.[1] ||
    around.match(/"title":\{"simpleText":"([^"]{2,160})"/)?.[1] ||
    around.match(/"accessibilityData":\{"label":"([^"]{2,160})"/)?.[1] ||
    "";
  let name = unescapeJson(title);
  /* หน้าช่องบางเลย์เอาต์ไม่มีชื่อคลิปวางใกล้ videoId เลย (ทดสอบกับ @Google แล้วว่าง)
     ถามหน้าคลิปเอาตรง ๆ ถูกกว่าเดาโครง JSON ที่ YouTube เปลี่ยนบ่อย */
  if (!name) {
    try {
      const w = await getPage(`https://www.youtube.com/watch?v=${ids[0]}`, 12_000);
      name = (w.match(/<meta name="title" content="([^"]+)"/) ||
        w.match(/<meta property="og:title" content="([^"]+)"/))?.[1] || "";
    } catch {
      /* ไม่มีชื่อก็ยังเล่าเนื้อหาได้ ไม่ต้องล้มทั้งงาน */
    }
  }
  return { videoId: ids[0]!, title: decodeHtml(name), channel: unescapeJson(channel) };
}

function decodeHtml(s: string): string {
  return (s || "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
}

function unescapeJson(s: string): string {
  try {
    return JSON.parse(`"${s.replace(/"/g, '\\"')}"`);
  } catch {
    return s;
  }
}

const PROMPT = `ดูคลิปนี้แล้วเล่าให้ฟังเป็นภาษาไทย เหมือนคนที่ดูจบแล้วมาเล่าให้เพื่อนร่วมงานฟัง

- เล่าเป็นความเรียง 4-8 ประโยค ตั้งแต่คลิปเปิดเรื่องยังไง ระหว่างทางพูดถึงอะไร แล้วสรุปหรือจบตรงไหน
- ใส่ชื่อคน ชื่อของ ตัวเลข และข้อสรุปตามที่ปรากฏในคลิปจริง
- ห้ามเขียนเป็นหัวข้อย่อย ห้ามขึ้นต้นบรรทัดด้วยขีด
- ห้ามลงท้ายด้วยคำถามย้อนกลับ ห้ามชวนให้ถามต่อ
- ถ้าดูแล้วเนื้อหาไม่พอจะเล่า ให้บอกตรง ๆ ว่าดูไม่ได้หรือเนื้อหาไม่พอ ห้ามแต่ง`;

export type VideoSummary = { text: string; model: string; tokens: number; cappedMin?: number };

/** เพดานความยาวที่ยอมให้ Gemini ดู — กันคลิปไลฟ์ยาว ๆ ทำค่าใช้จ่ายพุ่ง */
const MAX_WATCH_MIN = Number(process.env.GEMINI_VIDEO_MAX_MIN || 40);

/** ความยาวคลิปเป็นวินาที อ่านจากหน้า watch (ไม่ต้องใช้คีย์) — ไม่รู้ก็คืน 0 */
export async function videoDurationSec(videoId: string): Promise<number> {
  try {
    const w = await getPage(`https://www.youtube.com/watch?v=${videoId}`, 12_000);
    const iso = w.match(/<meta itemprop="duration" content="([^"]+)"/)?.[1];
    if (iso) {
      const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
      if (m) return (+(m[1] || 0)) * 3600 + (+(m[2] || 0)) * 60 + (+(m[3] || 0));
    }
    const sec = w.match(/"lengthSeconds":"(\d+)"/)?.[1];
    return sec ? Number(sec) : 0;
  } catch {
    return 0;
  }
}

/** ให้ Gemini ดูคลิปแล้วเล่ากลับมา — โยน error เมื่อทุกรุ่นล้ม ผู้เรียกต้องบอกผู้ใช้ตรง ๆ */
export async function summarizeYouTube(watchUrl: string): Promise<VideoSummary> {
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "";
  if (!key) throw new Error("ยังไม่ได้ตั้ง GEMINI_API_KEY");

  /* ค่าใช้จ่ายผูกกับความยาวคลิปตรง ๆ — วัดจริง 10 ก.ย. 2569 บน 3.1-flash-lite:
     คลิป ~10 นาที 32,341 โทเค็น ≈ 0.29 บาท · คลิปข่าวไอทียาว 123,134 โทเค็น ≈ 1.08 บาท
     ไลฟ์สามชั่วโมงจึงแพงได้หลายบาทต่อครั้ง ตัดให้ดูแค่ช่วงแรกแล้วบอกผู้ใช้ว่าตัด */
  const vid = watchUrl.match(/[?&]v=([\w-]{11})/)?.[1] || "";
  const durSec = vid ? await videoDurationSec(vid) : 0;
  const capped = durSec > MAX_WATCH_MIN * 60;

  const body = JSON.stringify({
    contents: [
      {
        parts: [
          { text: PROMPT },
          {
            file_data: { file_uri: watchUrl },
            ...(capped ? { video_metadata: { end_offset: `${MAX_WATCH_MIN * 60}s` } } : {}),
          },
        ],
      },
    ],
    generationConfig: { temperature: 0.3, thinkingConfig: { thinkingBudget: 0 } },
  });

  let lastErr = "";
  for (const model of [...new Set(MODELS)]) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          signal: AbortSignal.timeout(TIMEOUT_MS),
        }
      );
      const json = await res.json();
      if (!res.ok) {
        lastErr = `${model}: ${String(json?.error?.message || res.status).slice(0, 160)}`;
        continue;
      }
      const text = (json.candidates?.[0]?.content?.parts || [])
        .map((p: { text?: string }) => p.text || "")
        .join("")
        .trim();
      const usage = json.usageMetadata || {};
      recordUsage({
        provider: "gemini",
        model,
        task: "video",
        promptTokens: Number(usage.promptTokenCount || 0),
        completionTokens:
          Number(usage.candidatesTokenCount || 0) + Number(usage.thoughtsTokenCount || 0),
      });
      trace("compose", `🎬 ดูคลิป · ${model} · ${usage.totalTokenCount ?? "?"} โทเค็น`);
      if (!text) {
        lastErr = `${model}: ตอบกลับว่าง`;
        continue;
      }
      return { text, model, tokens: Number(usage.totalTokenCount || 0), ...(capped ? { cappedMin: MAX_WATCH_MIN } : {}) };
    } catch (e) {
      lastErr = `${model}: ${String(e).slice(0, 160)}`;
    }
  }
  throw new Error(lastErr || "ดูคลิปไม่สำเร็จ");
}
