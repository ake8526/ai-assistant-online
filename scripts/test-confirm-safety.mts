/**
 * Regression: confirmation words must not be stolen by RSVP / pre-pipeline.
 *
 * Run from ai-assistant-online:
 *   node --experimental-strip-types --experimental-transform-types scripts/test-confirm-safety.mts
 */
import {
  isShortConfirmText,
  assistantHasOutstandingConfirm,
  shouldDeferPrePipeline,
} from "../lib/confirmSafety.ts";
import { classifyMeetingRsvpText } from "../lib/meetingRsvpText.ts";

let failed = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    failed++;
    console.error("FAIL:", msg);
  } else {
    console.log("ok:", msg);
  }
}

assert(isShortConfirmText("ยืนยัน"), "bare ยืนยัน is short confirm");
assert(isShortConfirmText("ตกลง"), "ตกลง is short confirm");
assert(isShortConfirmText("ok"), "ok is short confirm");
assert(!isShortConfirmText("ยืนยันปิดงาน"), "ยืนยันปิดงาน is NOT short");
assert(!isShortConfirmText("ยืนยันเพิ่มงาน"), "ยืนยันเพิ่มงาน is NOT short");
assert(!isShortConfirmText("ยืนยันเข้าร่วมนัด"), "ยืนยันเข้าร่วมนัด is NOT short");

assert(assistantHasOutstandingConfirm("confirm_complete_task"), "confirm_complete_task outstanding");
assert(assistantHasOutstandingConfirm("confirm_add_task"), "confirm_add_task outstanding");
assert(assistantHasOutstandingConfirm("confirm_meeting"), "confirm_meeting outstanding");
assert(!assistantHasOutstandingConfirm("complete_task"), "complete_task not outstanding");
assert(!assistantHasOutstandingConfirm(undefined), "undefined not outstanding");

assert(
  shouldDeferPrePipeline("confirm_complete_task", "ยืนยัน"),
  "incident: ยืนยัน while confirm_complete_task → defer RSVP"
);
assert(
  shouldDeferPrePipeline("confirm_add_task", "ตกลง"),
  "ยืนยัน/ตกลง while confirm_add_task → defer RSVP"
);
assert(
  !shouldDeferPrePipeline("confirm_complete_task", "ยืนยันปิดงาน"),
  "specific ยืนยันปิดงาน is not short — pipeline handles it"
);
assert(
  !shouldDeferPrePipeline(undefined, "ยืนยัน"),
  "no outstanding confirm → do not defer"
);

assert(classifyMeetingRsvpText("ยืนยัน") === null, "RSVP must NOT accept bare ยืนยัน");
assert(classifyMeetingRsvpText("ตกลง") === null, "RSVP must NOT accept bare ตกลง");
assert(classifyMeetingRsvpText("ok") === null, "RSVP must NOT accept bare ok");
assert(classifyMeetingRsvpText("ยืนยันปิดงาน") === null, "RSVP must NOT accept ยืนยันปิดงาน");
assert(classifyMeetingRsvpText("ยืนยันเข้าร่วมนัด") === "accept", "RSVP accepts ยืนยันเข้าร่วมนัด");
assert(classifyMeetingRsvpText("ยืนยันนัดนี้") === "accept", "RSVP accepts ยืนยันนัดนี้");
assert(classifyMeetingRsvpText("เข้าร่วม") === "accept", "RSVP accepts เข้าร่วม");
assert(classifyMeetingRsvpText("ไม่สะดวก") === "decline", "RSVP declines ไม่สะดวก");

if (failed) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll confirm-safety regressions passed.");
