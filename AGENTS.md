<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Confirmation words belong to the question that was just asked

A short "ยืนยัน" / "ตกลง" / "ใช่" / "ok" must only answer the question the
assistant asked last. Never let it reach a handler that acts outside the
system — creating or deleting an Outlook event, sending an invite or mail,
pushing to someone else's LINE.

This is not hypothetical. "ปิดงานทั้งหมด" → confirm prompt → "ยืนยัน" once
accepted a day-old meeting invite and booked it in Outlook, because the RSVP
handler runs before the command pipeline in `app/api/line/webhook/route.ts`
and `getPendingRsvp()` counted any invite listing the user as an attendee as
still pending. The tasks the user meant to close stayed open.

When you add or touch a confirmation:

- Make the button send a **specific** word (`ยืนยันปิดงาน`, `ยืนยันจองเวลา`),
  and keep the label and the sent text in agreement.
- Anything running before the main pipeline (RSVP, reschedule, draft input)
  must check whether the assistant has its own question outstanding
  (`last_intent === "confirm_*"`) and step aside if so.
- "Waiting for an answer" state has to expire on reality: already answered,
  cancelled, or the meeting is over means it is no longer pending.
- A handler that matches broad wording needs a sweep of the phrases it could
  steal before you ship it.
- Check what actually happened in `chat_logs` and `agent_traces` on Supabase
  for the minute the user tapped, rather than reasoning from the code alone.
