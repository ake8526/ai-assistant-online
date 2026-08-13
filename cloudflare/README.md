# ตัวตั้งเวลาหลัก (Cloudflare Worker)

Worker นี้เป็น **ตัวยิงงานตามเวลาของ AI Assistant** แทน Vercel Cron / GitHub Actions
ที่ส่งไม่ตรงเวลา (สายประจำ 25–32 นาที — ดู `../docs/morning-delivery-plan.md`)

- ไฟล์เดียวคุมทุกตาราง: [`src/worker.js`](src/worker.js)
- ทำงานทุกนาที แล้วตัดสินใจจาก **เวลาไทย** ว่านาทีนี้ต้องยิงอะไร
- ฟรี: 1,440 ครั้ง/วัน จากโควตา 100,000 ครั้ง/วันของแพลน Free

## ตารางเวลา (เวลาไทย)

| เวลา | งาน | endpoint |
|---|---|---|
| **ทุกนาที 05:30–08:20** | ส่งของใครที่ถึงเวลานาทีนั้น (ข่าวก่อน ตารางตามหลัง 1 นาที) | `/api/brief/run?only=both` |
| **ทุกนาที 05:30–08:20** | เตรียมเนื้อหาล่วงหน้า — ข่าวก่อนเวลา 4–12 นาที, ตารางก่อน 1–3 นาที | `/api/morning/prewarm?stage=auto` |
| 08:30 ทุกวัน | ตรวจว่าเมื่อเช้าส่งตรงเวลาไหม (ช้า > 5 นาที → แจ้งผู้ดูแลทาง LINE) | `/api/morning/punctuality` |
| 08:20–20:55 ทุก 5 นาที | ตามเก็บของที่ยังไม่ได้ส่ง / คนที่ตั้งเวลากลางวัน | `/api/brief/run?only=both` |
| 08:20–20:55 ทุก **10** นาที จ–ศ | สรุปประชุมจาก transcript (งานยาวถึง 300 วิ จึงเว้น 10 นาทีกันทับกัน) | `/api/summaries/run` |
| ต้นชั่วโมง 09:00–20:00 จ–ศ | เตือนงานค้าง | `/api/reminders/run` |
| 08:20–20:55 ทุก 5 นาที ทุกวัน | แจ้งนัดใหม่ในปฏิทิน | `/api/calendar/notify` |

**Worker ไม่ได้ฮาร์ดโค้ดเวลาของใคร** — เวลาส่งอยู่ในตาราง `settings` (`news_time` / `brief_time`
ต่อผู้ใช้) ฝั่ง Vercel เป็นคนตัดสินว่าถึงเวลาของใคร Worker แค่เคาะให้ถี่พอ
ตอนนี้ผู้ใช้ตั้งไว้ 06:00 และ 07:00 ซึ่งอยู่ในช่วง 05:30–08:20 ทั้งคู่
ถ้ามีคนตั้งเวลานอกช่วงนี้ ต้องขยาย `MORNING_FROM_MIN` / `MORNING_TO_MIN` ใน `src/worker.js`

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
curl -sS "https://ktis-ai-scheduler.ktis-ake.workers.dev/?key=<CRON_SECRET>"
```

ดูแผนของนาที 07:00 วันจันทร์:

```bash
curl -sS "https://ktis-ai-scheduler.ktis-ake.workers.dev/?key=<CRON_SECRET>&at=07:00&dow=1"
```

ยิงงานของนาทีนี้จริง:

```bash
curl -sS "https://ktis-ai-scheduler.ktis-ake.workers.dev/?run=1&key=<CRON_SECRET>"
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

## ดูรายงานความตรงเวลาแบบไม่ส่งข้อความ

```bash
curl -sS -X POST -H "x-cron-secret: <CRON_SECRET>" "https://ktis-ai-assistant.vercel.app/api/morning/punctuality?dry=1"
```

ผู้รับรายงานเก็บไว้ในตาราง `settings` (`owner_upn=_ops`, `key=punctuality_admin`)
เปลี่ยนได้ด้วย `?to=<upn>` หรือ env `PUNCTUALITY_ADMIN_UPN` — ถ้าไม่ตั้งเลยจะบันทึกลง
`agent_traces` ให้ดูที่หน้า `/monitor` แต่ไม่ส่ง LINE

## หมายเหตุ

- Vercel Cron (`../vercel.json`) และ GitHub Actions (`../.github/workflows/cron.yml`)
  ยังเปิดไว้เป็น **ตัวสำรอง** ถ้า Worker ล่ม งานก็ยังออก (สายกว่า) และไม่ส่งซ้ำ
  เพราะ `claimSend`/`isDueNow` ใน `../lib/notify.ts` กันอยู่
- เวลาส่งของผู้ใช้เปลี่ยนได้จากในแอปโดย**ไม่ต้องแก้ Worker** — prewarm วิ่งตามเวลาของแต่ละคนเอง
- งานหนัก (สรุปประชุม/เตือนงาน/แจ้งนัด) ยิงแบบไม่รอผล (`background`) เพื่อไม่ให้ไปดันงานที่ต้องตรงเวลา
- ถ้าจะปิด Worker ชั่วคราว: `npx wrangler triggers delete` หรือ `npx wrangler delete` (ตัวสำรองจะรับช่วงต่อ แค่สายกว่า)
