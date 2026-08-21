"use client";

import { M365AuthProvider } from "@/components/M365AuthProvider";
import SetupBriefPreviewPanel from "@/components/SetupBriefPreviewPanel";

export default function SetupBriefPreviewPage() {
  return (
    <M365AuthProvider>
      <SetupBriefPreviewPanel />
    </M365AuthProvider>
  );
}
