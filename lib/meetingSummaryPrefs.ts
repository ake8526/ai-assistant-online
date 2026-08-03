// Opt-in for automatic LINE delivery of meeting summaries after calls end.
import { getSetting, setSetting } from "@/lib/store";

const K_ENABLED = "meeting_summary_line";

/** Default on (null) so existing users keep receiving summaries until they opt out. */
export async function isMeetingSummaryEnabled(upn: string): Promise<boolean> {
  const v = await getSetting(upn, K_ENABLED);
  return v === null ? true : v === "1";
}

export async function setMeetingSummaryEnabled(upn: string, enabled: boolean): Promise<void> {
  await setSetting(upn, K_ENABLED, enabled ? "1" : "0");
}
