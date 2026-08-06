"use client";

import { AdminGate, ConsolePage } from "@/ui/ConsoleShell";
import { LiveOperations } from "@/ui/Dashboard";

export default function OverviewPage() {
  return (
    <ConsolePage active="overview" title="Live Operations" embeddedHeader>
      <AdminGate>
        <LiveOperations />
      </AdminGate>
    </ConsolePage>
  );
}
