"use client";

import { AdminGate, ConsolePage } from "@/ui/ConsoleShell";
import { SystemStatus } from "@/ui/Dashboard";

export default function SystemPage() {
  return (
    <ConsolePage
      active="system"
      title="System Health & Configuration"
      embeddedHeader
    >
      <AdminGate>
        <SystemStatus />
      </AdminGate>
    </ConsolePage>
  );
}
