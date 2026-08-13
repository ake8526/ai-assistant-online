# ตัวตั้งเวลาหลัก (Cloudflare Worker)

Worker นี้เป็น **ตัวยิงงานตามเวลาของ AI Assistant** แทน Vercel Cron / GitHub Actions
ที่ส่งไม่ตรงเวลา (สายประจำ 25–32 นาที — ดู `../docs/morning-delivery-plan.md`)

- ไฟล์เดียวคุมทุกตาราง: [`src/worker.js`](src/worker.js)
- ทำงานทุกนาที แล้วตัดสินใจจาก **เวลาไทย** ว่านาทีนี้ต้องยิงอะไร
- ฟรี: 1,440 ครั้ง/วัน จากโควตา 100,000 ครั้ง/วันของแพลน Free

## ตารางเวลา (เวลาไทย)

| เวลา | งาน | endpoint |
|---|---|---|
| 06:50 / 06:53 / 06:56 จ–ศ | เตรียมข่าวล่วงหน้า (สร้าง ~100 วิ) | `/api/morning/prewarm?stage=news` |
| 06:59 จ–ศ | เตรียมตารางเช้า + ปลุก function | `/api/morning/prewarm?stage=brief` |
| **07:00 จ–ศ** | **ส่งข่าว** (push จากที่เตรียมไว้ <1 วิ) | `/api/brief/run?only=news` |
| **07:01 จ–ศ** | **ส่งสรุปประชุม/ตาราง** | `/api/brief/run?only=brief` |
| 07:02–07:10 จ–ศ | ตามเก็บทุกนาที (ส่งแล้วข้ามเอง) | `/api/brief/run?only=both` |
| 07:00–20:55 ทุก 5 นาที | poll เผื่อผู้ใช้ตั้งเวลาส่งเองไม่ใช่ 07:00 | `/api/brief/run?only=both` |
| 08:00–20:55 ทุก 5 นาที จ–ศ | สรุปประชุมจาก transcript | `/api/summaries/run` |
| ต้นชั่วโมง 08:00–20:00 จ–ศ | เตือนงานค้าง | `/api/reminders/run` |
| 08:00–20:55 ทุก 5 นาที ทุกวัน | แจ้งนัดใหม่ในปฏิทิน | `/api/calendar/notify` |

## Deploy (ทำครั้งเดียว)

ต้องมีบัญชี Cloudflare (ฟรี) — สมัครที่ https://dash.cloudflare.com/sign-up

```bash
cd cloudflare
npx wrangler login
```

ใส่ค่า `CRON_SECRET` ให้ **ตรงกับที่ตั้งไว้บน Vercel** (Project → Settings → Environment Variables):

```bash
npx wrangler secret put CRON_SECRET
```

```bash
npx wrangler deploy
```

## ตรวจว่าใช้งานได้

ดูว่าตอนนี้ Worker คิดว่าต้องยิงอะไร (ไม่ยิงจริง):

```bash
curl -sS "https://ktis-ai-scheduler.<subdomain>.workers.dev/?key=<CRON_SECRET>"
```

ดูแผนของนาที 07:00 วันจันทร์:

```bash
curl -sS "https://ktis-ai-scheduler.<subdomain>.workers.dev/?key=<CRON_SECRET>&at=07:00&dow=1"
```

ยิงงานของนาทีนี้จริง:

```bash
curl -sS "https://ktis-ai-scheduler.<subdomain>.workers.dev/?run=1&key=<CRON_SECRET>"
```

ดู log สด:

```bash
npx wrangler tail
```

## ซ้อมส่งจริงโดยไม่ต้องรอเช้า

เตรียมของ แล้วสั่งส่งทันทีด้วย `force=1` (ข้ามการเช็คเวลา/กันส่งซ้ำ):

```bash
curl -sS -X POST -H "x-cron-secret: <CRON_SECRET>" "https://ktis-ai-assistant.vercel.app/api/morning/prewarm?wait=1&force=1&upn=weerasak.pi@ktisgroup.com"
```

```bash
curl -sS -X POST -H "x-cron-secret: <CRON_SECRET>" "https://ktis-ai-assistant.vercel.app/api/brief/run?only=both&force=1&upn=weerasak.pi@ktisgroup.com"
```

## หมายเหตุ

- Vercel Cron (`../vercel.json`) และ GitHub Actions (`../.github/workflows/cron.yml`)
  ยังเปิดไว้เป็น **ตัวสำรอง** ถ้า Worker ล่ม งานก็ยังออก (สายกว่า) และไม่ส่งซ้ำ
  เพราะ `claimSend`/`isDueNow` ใน `../lib/notify.ts` กันอยู่
- เวลาส่งของผู้ใช้แต่ละคนตั้งได้เองในฐานข้อมูล (`settings`: `news_time`, `brief_time`)
  ค่าเริ่มต้น 07:00 / 07:01 จะได้ความแม่นระดับวินาทีเพราะมี prewarm รองรับ
  ส่วนเวลาอื่นจะถูกจับด้วย poll ทุก 5 นาที และสร้างเนื้อหาสด (ช้ากว่า ~100 วิ)
  ถ้าย้ายเวลาเริ่มต้นของทีม ต้องเลื่อนเวลา prewarm ใน `src/worker.js` ตามด้วย
