# KTIS X AI Assistant (online)

Next.js app on Vercel — work assistant for KTIS: chat commands (web + LINE), morning brief, meeting prep/summary, tasks + reminders, find/book/cancel meetings, news digest.

Repo: `ake8526/ai-assistant-online` · Live: https://ktis-ai-assistant.vercel.app

## App entry

| Path | What |
| --- | --- |
| `/` | Main React shell (tabs: ผู้ช่วย / ตาราง / งาน / ตั้งค่า) — **canonical** |
| `/line-link` | Link M365 ↔ LINE (LIFF) |
| `/consents`, `/settings`, `/setup` | Consent + settings flows |
| `/api/line/webhook` | LINE Messaging API |
| `/api/command` | Same command brain as LINE (used by web chat) |

Legacy `/mobile`, `/chat`, `/index.html` redirect to `/`.

## Local dev

```bash
npm install
cp .env.example .env.local   # if present; otherwise copy known Vercel env keys
npm run dev
```

Open http://localhost:3000

Required env (high level): M365 app registration, Supabase, LINE channel tokens, LLM keys. See `docs/` in the parent workspace and Vercel project settings.

## Checks

```bash
npm run test:confirm   # confirmation-word / RSVP collision regressions
npm run build
```

## Agent rules

Before changing confirmation or LINE webhook behavior, read [`AGENTS.md`](./AGENTS.md). Short words like "ยืนยัน" must only answer the question the assistant just asked.

## UX plan

Workspace plan + preview: `docs/ux-v6-improvement-plan.md`, `ux-v6-preview.html` (parent folder).
