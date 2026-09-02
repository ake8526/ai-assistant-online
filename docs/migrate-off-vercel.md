# แผนย้ายออกจาก Vercel

เขียน 2 ก.ย. 2026 · ไล่จากโค้ดจริงในคอมมิตวันนั้น ไม่ใช่จากความจำ
ตัวเลขทุกตัวในเอกสารนี้นับจากไฟล์จริง ถ้าโค้ดเปลี่ยนแล้วเอกสารนี้ควรถูกนับใหม่

---

## 1. Vercel ทำอะไรอยู่

| หน้าที่ | รายละเอียด |
| --- | --- |
| รัน Next.js ทั้งแอป | 59 API route + ทุกหน้าเว็บ (`/`, `/monitor/*`, `/s/[token]`, `/n/[token]`, `/r/[code]`, `/todo/*`, `/line-link`, `/setup`) |
| โดเมนสาธารณะ | `ktis-ai-assistant.vercel.app` — ที่อยู่ที่ LINE, Microsoft, Cloudflare Worker, GitHub Actions และ APK ยิงเข้ามา |
| ปลายทาง webhook ไลน์ | `POST /api/line/webhook` |
| ปลายทาง OAuth | `/api/oauth/microsoft/callback` (ลงทะเบียนไว้ใน Entra) |
| เสิร์ฟไฟล์ static | `public/` **41 ไฟล์บนดิสก์ แต่อยู่ใน git แค่ 30** รวม **APK 4.2 MB** ที่คนโหลดไปติดตั้ง และรูป/วิดีโอราว 14 MB |
| เก็บ environment variables | 28 ตัว (ดูข้อ 3) |
| cron สำรอง 2 ตัว | `vercel.json` — ตัวหลักคือ Cloudflare Worker |
| build/deploy | push `main` → build → deploy อัตโนมัติ |

### ที่ไม่ได้อยู่บน Vercel — ย้ายแล้วไม่กระทบ

- **Supabase** — ฐานข้อมูลทั้งหมด (tasks, settings, line_links, oauth_tokens, chat_logs, agent_traces, feeds, consents)
- **Cloudflare Worker** `ktis-ai-scheduler` — ตัวตั้งเวลาหลัก ยิงทุกนาที
- **LINE** OA + LIFF · **Entra ID** app registration · **Firebase FCM** · **Qwen / Groq / Gemini** · **NewsData**

---

## 2. ข้อเท็จจริงที่ทำให้การย้ายง่ายกว่าที่คิด

**ไม่มีข้อมูลอยู่บน Vercel เลย** ไล่หาการเขียนดิสก์ตอน runtime ทั้งโครงการแล้วเจอสองจุด
และทั้งสองจุดไม่ใช่ข้อมูลผู้ใช้:

- `lib/lineRichMenu.ts:239` — เขียนไฟล์ config ฟอนต์ลง `os.tmpdir()`
- `lib/lineRichMenu.ts:268` — cache รูปเมนู ห่อ `try/catch` ไว้แล้วพร้อมคอมเมนต์ว่า
  "ignore on read-only fs"

แปลว่า **ไม่ต้อง export หรือ dump อะไรจาก Vercel** ปิดโปรเจกต์ทิ้งได้เลยเมื่อย้ายเสร็จ

---

## 3. ของที่ต้องเอาไป

### กอง 1 — โค้ด (อยู่ใน GitHub ครบแล้ว)

`ake8526/ai-assistant-online` ไม่มีอะไรค้างบน Vercel แต่ของสามอย่างนี้คนมักลืมเพราะ
อยู่ใน git อยู่แล้วและไม่ได้อยู่ในโฟลเดอร์โค้ด:

- [ ] `public/` — **30 ไฟล์ที่อยู่ใน git** รวม `KTISX-AI-Assistant.apk`
      ⚠️ บนเครื่องมี 41 ไฟล์ — **11 ไฟล์ยังไม่ถูก commit** (หน้า preview ต่าง ๆ:
      `login-preview.html`, `mobile-*.html`, `splash-preview.html`, `ux-v*-preview.html`,
      `robot-reading.webp`, `robot-reading-front.png`)
      ถ้าไฟล์ไหนยังใช้อยู่ **ต้อง commit ก่อนย้าย** ไม่งั้นหายไปเลย เพราะโฮสต์ใหม่
      build จาก git ไม่ใช่จากเครื่องนี้ — เช็กด้วย `git status --porcelain public`
- [ ] `assets/fonts/NotoSansThai-{Bold,Regular}.ttf` — ใช้วาดรูป rich menu
      ถ้าหาย `/api/line/rich-menu` จะพัง
- [ ] `cloudflare/` — ซอร์สตัวตั้งเวลา (ต้องแก้ `BASE` ดูข้อ 6)

### กอง 2 — environment variables (ไม่อยู่ใน git — นี่คือของจริงที่ต้องคัดลอก)

| ตัวแปร | กลุ่ม | หมายเหตุ |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | ฐานข้อมูล | ฝังตอน build |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | ฐานข้อมูล | ฝังตอน build |
| `SUPABASE_SERVICE_KEY` | ฐานข้อมูล | **ความลับสูงสุด** — ข้ามสิทธิ์ทุกแถว |
| `LINE_CHANNEL_ACCESS_TOKEN` | ไลน์ | |
| `LINE_CHANNEL_SECRET` | ไลน์ | ใช้ตรวจลายเซ็น webhook **และ** เซ็นลิงก์ในลิงก์ต่าง ๆ |
| `NEXT_PUBLIC_LIFF_ID` | ไลน์ | ฝังตอน build |
| `GRAPH_CLIENT_ID` | Microsoft | |
| `GRAPH_CLIENT_SECRET` | Microsoft | มีวันหมดอายุ — เช็กด้วยว่าเหลือเท่าไร |
| `TENANT_ID` | Microsoft | |
| `NEXT_PUBLIC_AZURE_CLIENT_ID` | Microsoft | ฝังตอน build |
| `NEXT_PUBLIC_AZURE_TENANT_ID` | Microsoft | ฝังตอน build |
| `LLM_PROVIDER` | AI | ลำดับผู้ให้บริการ |
| `QWEN_API_KEY` `QWEN_BASE_URL` `QWEN_MODEL` | AI | ตัวหลัก |
| `GROQ_API_KEY` `GROQ_MODEL` | AI | ตัวสำรอง |
| `GEMINI_API_KEY` `GEMINI_MODEL` | AI | ใช้สรุปประชุมเท่านั้น |
| `NEWSDATA_API_KEY` `NEWSDATA_COUNTRIES` `NEWSDATA_LANGUAGES` | ข่าว | |
| `GOOGLE_CLIENT_ID` `GOOGLE_CLIENT_SECRET` `GOOGLE_OAUTH_REDIRECT` | YouTube (`lib/youtube.ts`) | **`GOOGLE_OAUTH_REDIRECT` มีโดเมนอยู่ในค่า** ต้องแก้ |
| `CRON_SECRET` | ระบบ | Worker/Actions ใช้ยิง cron |
| `TIMEZONE` | ระบบ | `Asia/Bangkok` |
| `NEXT_PUBLIC_APP_BASE_URL` | ระบบ | **ค่านี้คือหัวใจของการย้าย** ฝังตอน build |

**ไม่ต้องเอาไป:** `VERCEL_OIDC_TOKEN` (ของแพลตฟอร์ม Vercel เอง)

**ยังไม่มีและควรตั้งที่ใหม่ทีเดียว:** `FCM_SERVICE_ACCOUNT` — แจ้งเตือนขึ้นเครื่อง
ยังไม่ทำงานเพราะไม่มีค่านี้ (ดู `docs/push-fcm.md`)

> ⚠️ ตัวที่ขึ้นต้น `NEXT_PUBLIC_` **ถูกฝังลงไปในไฟล์ JavaScript ตอน build**
> ไม่ใช่อ่านตอนรัน — ถ้าตั้งไม่ครบตอน build หน้าเว็บจะยังชี้โดเมนเก่า
> และแก้ทีหลังด้วยการ restart ไม่ได้ ต้อง build ใหม่

### กอง 3 — ข้อมูล

ไม่มี ดูข้อ 2

---

## 4. โฮสต์ใหม่ต้องรองรับอะไร

- [ ] **Node.js runtime** (ยังไม่ล็อกใน `package.json` — ควรใส่ `engines` เป็น Node 20 หรือ 22
      ตอนย้าย เพื่อไม่ให้เครื่อง build กับเครื่องรันใช้คนละเวอร์ชัน)
- [ ] `npm ci` → `next build` → `next start` — **ไม่ใช่ static export** ทุกอย่างเป็น server
- [ ] **ฟังก์ชันรันได้เกิน 60 วินาที** — 5 route ตั้ง `maxDuration = 300`:
      - `app/api/brief/run/route.ts` (สรุปตารางเช้า)
      - `app/api/summaries/run/route.ts` (สรุปประชุม)
      - `app/api/line/webhook/route.ts`
      - `app/api/morning/prewarm/route.ts`
      - `app/api/digest/line-now/route.ts`

      อีก 4 route ตั้ง 120 วิ และ 14 route ตั้ง 60 วิ
      **โฮสต์ที่จำกัด CPU time สั้น ๆ (เช่น Cloudflare Workers) ใช้ไม่ได้กับ 5 route นี้**
- [ ] `after()` ของ Next — ใช้ 7 ที่ (งานที่วิ่งต่อหลังส่ง response)
- [ ] `sharp` — ต้องมี native binary ในสภาพแวดล้อมที่รัน
- [ ] **HTTPS + certificate ที่เชื่อถือได้** — LINE ไม่รับ self-signed
- [ ] ถ้าใช้ Docker / `output: standalone`: **ต้องคัดลอก `public/` และ `assets/` เข้า image เอง**
      (`next.config.ts` มี `outputFileTracingIncludes` สำหรับฟอนต์ของ `/api/line/rich-menu` อยู่แล้ว
      แต่ standalone ต้องตรวจว่าไฟล์ไปถึงจริง)
- [ ] `next.config.ts` มี `headers()` สั่ง `no-store` ให้บางหน้า — ถ้าเอา reverse proxy
      มาครอบ อย่าให้ proxy แคชทับ ไม่งั้นเบราว์เซอร์ในแอปไลน์จะติดหน้าเก่า

---

## 5. โค้ดที่ต้องแก้ก่อนย้าย (ทำได้เลยตอนยังอยู่ Vercel)

### 5.1 `waitUntil` ของ Vercel — 4 จุด ⚠️ ถ้าไม่แก้ งานเบื้องหลังพังเงียบ

`import { waitUntil } from "@vercel/functions"` ที่อื่นไม่มีของนี้ ต้องเปลี่ยนไปใช้
`after()` ของ Next ซึ่งโครงการนี้ใช้อยู่แล้ว 7 ที่

- [ ] `lib/commands.ts:20`
- [ ] `lib/digestKick.ts:6`
- [ ] `app/api/digest/push/route.ts:8`
- [ ] `app/api/morning/prewarm/route.ts:17`

กระทบ: สรุปเช้า · ข่าวประจำวัน · digest — ของที่ "ยิงแล้วปล่อยให้วิ่งต่อ"
บนแพลตฟอร์มอื่นฟังก์ชันจะถูกปิดก่อนงานเสร็จ **โดยไม่มี error** ให้เห็น

### 5.2 โดเมน fallback ฝังในโค้ด — 12 จุด

ทุกจุดเขียนแบบเดียวกัน:

```ts
(process.env.NEXT_PUBLIC_APP_BASE_URL || "https://ktis-ai-assistant.vercel.app")
```

- [ ] `lib/summaryPage.ts` · `lib/newsPage.ts` · `lib/consentLink.ts` · `lib/gpsCapture.ts`
- [ ] `lib/fileOpenLink.ts` · `lib/lineRichMenu.ts` · `lib/help.ts` · `lib/followup.ts`
- [ ] `lib/digestKick.ts` · `lib/commands.ts` · `lib/newsOnboarding.ts`
- [ ] **`lib/msGraphOAuth.ts:60`** — ตัวนี้สำคัญกว่าเพื่อน เพราะเป็นตัว **ประกอบ
      redirect URI** ที่ส่งไปให้ Microsoft (`<base>/api/oauth/microsoft/callback`)
      ตั้ง base ผิด = ล็อกอินไม่ผ่านทั้งระบบ ด้วยข้อความ redirect_uri mismatch
      (จุดนี้ไม่มี fallback เป็นโดเมน Vercel แต่ fallback เป็นค่าว่าง — ลืมตั้ง env
      แล้ว redirect URI จะกลายเป็น `/api/oauth/...` เฉย ๆ ซึ่ง Entra ปฏิเสธ)
      มี `MICROSOFT_OAUTH_REDIRECT` ให้ override ได้ถ้าต้องการระบุตรง ๆ

**ทำเป็น `lib/appUrl.ts` ที่เดียว และไม่มี fallback** — ให้ throw ตอน build ถ้าไม่มีค่า
ดีกว่าเงียบ ๆ ส่งลิงก์โดเมนเก่าไปให้ผู้ใช้ในไลน์ (อาการจะโผล่หลังย้ายหลายวันและ
หายากมาก เพราะทุกอย่าง "ทำงานปกติ" ยกเว้นลิงก์)

### 5.3 สคริปต์ที่ฝังโดเมน (ไม่กระทบผู้ใช้ แต่ควรแก้ให้ครบ)

- [ ] `scripts/reset-line-as-new-friend.ts`
- [ ] `scripts/send-calendar-link-to-nont.ts`
- [ ] `scripts/send-setup-test-to-ake.ts`

---

## 6. ระบบภายนอกที่ต้องไปแก้

| ที่ไหน | แก้อะไร | หมายเหตุ |
| --- | --- | --- |
| **Entra ID** → App registrations → ai-assistant-agent → Authentication | **เพิ่ม** redirect URI `https://<โดเมนใหม่>/api/oauth/microsoft/callback` | **อย่าลบของเก่า** จนกว่าจะย้ายเสร็จและเฝ้าครบหนึ่งเช้า — ใส่ได้หลายอันพร้อมกัน |
| **LINE Developers** → Messaging API | Webhook URL → `https://<โดเมนใหม่>/api/line/webhook` แล้วกด Verify | สลับได้ทันที มีผลกับข้อความถัดไปเลย |
| **LINE Developers** → LIFF | Endpoint URL → `https://<โดเมนใหม่>/line-link` | ถ้าไม่แก้ คนผูกบัญชีใหม่จะไปหน้าเก่า |
| **Rich menu ในไลน์** | สร้างใหม่ด้วย `scripts/apply-rich-menu.ts` หลังโดเมนใหม่ใช้งานได้ | ปุ่มบนเมนูฝัง URL ไว้ในตัว |
| **`cloudflare/wrangler.toml:19`** | `BASE = "https://<โดเมนใหม่>"` แล้ว `wrangler deploy` | **ตัวตั้งเวลาหลัก** ไม่แก้ = ทุกงานตามเวลาไปยิงโฮสต์เก่า |
| **`.github/workflows/cron.yml`** | `BASE` | ตัวสำรอง (GitHub throttle เหลือ ~1 ครั้ง/ชม.) |
| **Google Cloud Console** (ถ้าใช้ YouTube) | Authorized redirect URI + env `GOOGLE_OAUTH_REDIRECT` | |

---

## 7. cron 2 ตัวที่จะหายไปพร้อม Vercel

`vercel.json` มี:

```json
{ "path": "/api/morning/prewarm?stage=both", "schedule": "40 23 * * 0-4" }
{ "path": "/api/brief/run?only=both",        "schedule": "0 0 * * 1-5" }
```

(เวลา UTC → 06:40 และ 07:00 เวลาไทย จันทร์–ศุกร์)

ทั้งสองงานนี้ **Cloudflare Worker ทำอยู่แล้ว** (`cloudflare/src/worker.js` บรรทัด 65–66
มี `deliver` และ `prewarm`) — Vercel cron เป็นแค่ตัวสำรองเพราะ Hobby cron เคยช้าไป
30 นาที

- [ ] ยืนยันว่า Worker ยิงสองงานนี้จริงจาก `/monitor/log` หนึ่งเช้าก่อนย้าย
- [ ] ถ้าอยากมีตัวสำรอง ใช้ `.github/workflows/cron.yml` ที่มีอยู่ (แก้ `BASE`)
- [ ] **ไม่ต้องสร้าง cron ใหม่ที่โฮสต์ใหม่**

งานตามเวลาทั้งหมดที่ Worker ยิง (จะย้ายไปพร้อม `BASE` เดียว):
`/api/brief/run` · `/api/morning/prewarm` · `/api/morning/punctuality` ·
`/api/reminders/run` · `/api/summaries/run` · `/api/calendar/notify`

---

## 8. APK — จุดเดียวที่กระทบผู้ใช้จริง

```java
// android_app/app/src/main/java/com/ktis/aiassistant/MainActivity.java:35
private static final String APP_URL = "https://ktis-ai-assistant.vercel.app/";
```

URL ฝังตายในแอป **คนที่ไม่อัปเดตจะเปิดแอปไม่ได้เลย** หลังโดเมนเก่าหยุดทำงาน

- [ ] แก้ `APP_URL` เป็นโดเมนใหม่
- [ ] `versionCode` ต้องเดินหน้า และเซ็นด้วย keystore เดิม (`release.keystore`)
      ไม่งั้นอัปเดตทับไม่ได้ ต้องถอนก่อน — วิธี build อยู่ใน `docs/push-fcm.md`
- [ ] วางไฟล์ใหม่ที่ `public/KTISX-AI-Assistant.apk`
- [ ] **แจกให้อัปเดตล่วงหน้าก่อนย้าย DNS** ไม่ใช่หลัง
- [ ] ผู้ใช้ที่ต้องอัปเดต: ดูจำนวนที่ `/monitor/users`

**ทางลดความเจ็บระยะยาว:** ให้ `APP_URL` อ่านจากปลายทางที่เปลี่ยนได้ (เช่น redirect
สั้น ๆ ที่เราคุม) แล้วย้ายโฮสต์รอบหน้าจะไม่ต้องแตะ APK อีก — ทำได้ในคอมมิตเดียว
ตอนแก้ APK รอบนี้

---

## 9. ลำดับการย้ายที่ไม่ทำให้ล่ม

### ระยะ 1 — เตรียม (ยังอยู่ Vercel ไม่กระทบใคร)

- [ ] แก้ `waitUntil` → `after()` ทั้ง 4 จุด (ข้อ 5.1)
- [ ] รวมโดเมนเป็น `lib/appUrl.ts` ที่เดียว ไม่มี fallback (ข้อ 5.2)
- [ ] ใส่ `engines` ใน `package.json`
- [ ] deploy ขึ้น Vercel แล้วตรวจว่าทุกอย่างยังปกติ (โดเมนยังเดิม ยังไม่มีอะไรเปลี่ยน)

### ระยะ 2 — ยกขึ้นโฮสต์ใหม่ด้วย "โดเมนชั่วคราว"

- [ ] ตั้ง env ครบ 27 ตัว **ก่อน** build
- [ ] build + start ให้ผ่าน
- [ ] Entra: เพิ่ม redirect URI ของโดเมนชั่วคราว (**เพิ่ม ไม่ใช่แทน**)
- [ ] ทดสอบตามข้อ 10 ให้ครบ — ระหว่างนี้ผู้ใช้จริงยังใช้ Vercel อยู่ ไม่รู้สึกอะไร

### ระยะ 3 — APK

- [ ] build APK ใหม่ชี้โดเมนจริง แจกให้อัปเดต
- [ ] รอให้คนอัปเดตครบ (เช็กจาก `/monitor/users` — คอลัมน์อุปกรณ์แจ้งเตือน
      หรือดูจาก `agent_traces` ว่ามีใครยังเข้ามาทางแอปเก่า)

### ระยะ 4 — สลับจริง (นาทีทองมีผลจริงช่วงนี้)

ทำเรียงกันให้เร็ว ควรเลือกช่วง **บ่ายวันศุกร์** — ห่างจากรอบเช้า 06:40/07:00 มากที่สุด

- [ ] ชี้ DNS โดเมนจริงมาที่โฮสต์ใหม่ + รอ cert ออก
- [ ] Entra: เพิ่ม redirect URI ของโดเมนจริง
- [ ] LINE: สลับ Webhook URL + Verify
- [ ] LINE: สลับ LIFF endpoint
- [ ] `wrangler.toml` → `BASE` ใหม่ → `wrangler deploy`
- [ ] `.github/workflows/cron.yml` → `BASE` ใหม่
- [ ] สร้าง rich menu ใหม่
- [ ] ทดสอบตามข้อ 10 อีกรอบบนโดเมนจริง

### ระยะ 5 — เฝ้าและเก็บกวาด

- [ ] เฝ้า `/monitor/log` **หนึ่งเช้าเต็ม** ให้ผ่านรอบ 06:40 และ 07:00
- [ ] ดู `/monitor` ว่างานตามเวลาทุกตัวเข้ามาครบ (6 งานในข้อ 7)
- [ ] ค่อยลบ redirect URI เก่าออกจาก Entra
- [ ] ค่อยปิดโปรเจกต์ Vercel (ไม่มีข้อมูลต้องกู้ — ข้อ 2)

---

## 10. รายการทดสอบ (ใช้ได้ทั้งระยะ 2 และ 4)

ทดสอบตามลำดับนี้ เพราะข้อหลังพึ่งข้อหน้า

| # | ทดสอบ | ผ่านคือ |
| --- | --- | --- |
| 1 | เปิดหน้าแรก | โหลดได้ ไม่มี error ใน console |
| 2 | ล็อกอิน Microsoft | เข้าได้ ไม่เด้ง redirect_uri mismatch |
| 3 | `/api/health` | ทุกส่วนเขียว ยกเว้นที่รู้อยู่แล้วว่าปิด |
| 4 | แท็บตาราง | เห็นนัดจากปฏิทินจริง (พิสูจน์ Graph + token) |
| 5 | แท็บงาน | เห็นงานค้าง และตอบเร็ว (< 1 วิ) |
| 6 | ไลน์: `ตารางวันนี้` | ตอบกลับได้ (พิสูจน์ webhook + ลายเซ็น) |
| 7 | ไลน์: `ดูงานที่ต้องติดตาม` | การ์ดขึ้นครบ ปุ่มกดได้ |
| 8 | ไลน์: `เชื่อม todo` | **ปุ่มในไลน์ต้องชี้โดเมนใหม่** (พิสูจน์ข้อ 5.2 ว่าแก้ครบ) |
| 9 | ไลน์: `ซิงค์ todo` | ตัวเลขขึ้นถูก |
| 10 | ลิงก์สรุปประชุม (`/s/<token>`) | เปิดได้โดยไม่ต้องล็อกอิน |
| 11 | `/monitor/log` | เห็น trace ของที่เพิ่งทดสอบ |
| 12 | `/monitor/users` · `/monitor/todo` | โหลดได้ กดปุ่มขึ้นกล่องยืนยัน |
| 13 | ยิง `/api/reminders/run?key=<CRON_SECRET>` | `ok: true` และมี `alarms` + `todo` |
| 14 | `/api/line/rich-menu` | สร้างรูปได้ (พิสูจน์ `sharp` + ฟอนต์ไทยไปถึง) |
| 15 | สั่งสรุปประชุมหนึ่งนัด | ทำจนจบ ไม่ตัดกลางทาง (พิสูจน์ว่ารันเกิน 60 วิได้) |

**ข้อ 8 กับ 14 กับ 15 คือสามข้อที่จับปัญหาการย้ายได้จริง** ข้ออื่นผ่านง่ายอยู่แล้ว

---

## 11. แผนถอย

ทุกอย่างถอยได้เพราะ **ข้อมูลอยู่ Supabase ไม่ได้อยู่กับโฮสต์**

| ถ้าพังตรงไหน | ถอยยังไง | ใช้เวลา |
| --- | --- | --- |
| โฮสต์ใหม่ล่ม/ช้า | ชี้ DNS กลับ Vercel | เท่า TTL ของ DNS — **ตั้ง TTL ให้ต่ำ (60–300 วิ) ก่อนย้ายหนึ่งวัน** |
| ไลน์ไม่ตอบ | สลับ Webhook URL กลับ | ทันที |
| งานตามเวลาไม่วิ่ง | `wrangler.toml` → `BASE` เดิม → deploy | ~1 นาที |
| ล็อกอินไม่ได้ | redirect URI เก่ายังอยู่ใน Entra (ห้ามลบเร็ว) | ทันที |
| APK เปิดไม่ได้ | โดเมนเก่ายังเปิดอยู่ | — |

**เงื่อนไขสำคัญ: อย่าปิด Vercel และอย่าลบ redirect URI เก่า จนกว่าจะเฝ้าผ่านหนึ่งเช้า**

---

## 12. ความเสี่ยงเรียงตามความน่าเจ็บ

| ความเสี่ยง | ผลถ้าเกิด | กันไว้ยังไง |
| --- | --- | --- |
| APK ยังชี้โดเมนเก่า | ผู้ใช้เปิดแอปไม่ได้เลย | แจก APK ใหม่ **ก่อน** ย้าย DNS · เก็บโดเมนเก่าไว้ก่อน |
| ลืมแก้โดเมน fallback บางจุด | ลิงก์ในไลน์ชี้โฮสต์เก่า **โดยไม่มี error** | ข้อ 5.2 เอา fallback ออกให้พังตอน build · ทดสอบข้อ 8 |
| `waitUntil` ไม่มีที่โฮสต์ใหม่ | สรุปเช้า/ข่าว/digest ค้างครึ่งทาง **เงียบ ๆ** | ข้อ 5.1 |
| โฮสต์ใหม่จำกัดเวลา 60 วิ | สรุปประชุมยาวไม่จบ | ข้อ 4 · ทดสอบข้อ 15 |
| ลืมตั้ง `NEXT_PUBLIC_*` ตอน build | หน้าเว็บชี้โดเมนเก่า restart ไม่ช่วย | ตั้ง env ให้ครบก่อน build |
| `GRAPH_CLIENT_SECRET` หมดอายุพอดี | ล็อกอินและปฏิทินตายทั้งระบบ | เช็กวันหมดอายุก่อนเริ่มย้าย |
| ฟอนต์ไทยไม่ไปถึงใน Docker | สร้าง rich menu ไม่ได้ | ทดสอบข้อ 14 |
| แคชของ proxy ทับ `no-store` | เบราว์เซอร์ในแอปไลน์ติดหน้าเก่า | อย่าให้ proxy แคช HTML |

---

## 13. สรุปสั้นที่สุด

- **เอาไป:** env 28 ตัว (ตัดตัวของ Vercel ออกหนึ่ง) · `public/` (commit 11 ไฟล์ที่ค้างก่อน) · `assets/fonts/`
- **ไม่ต้องเอา:** ข้อมูล — ไม่มีอยู่บน Vercel เลย
- **แก้โค้ดก่อน:** `waitUntil` 4 จุด · โดเมน fallback 12 จุด (รวมตัวที่ทำ redirect URI)
- **แก้ข้างนอก:** Entra · LINE webhook · LIFF · rich menu · Worker `BASE` · Actions `BASE`
- **cron:** ไม่ต้องสร้างใหม่ Worker ทำอยู่แล้ว
- **จุดเดียวที่ผู้ใช้เจ็บ:** APK — ต้อง build ใหม่และแจกก่อนย้าย
