"use client";

import { M365AuthProvider } from "@/components/M365AuthProvider";
import SetupTestPanel from "@/components/SetupTestPanel";

export default function SetupTestPage() {
  return (
    <M365AuthProvider>
      <SetupTestPanel />
    </M365AuthProvider>
  );
}
