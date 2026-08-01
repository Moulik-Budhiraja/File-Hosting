"use client";

import { ApiKeysView } from "@/ui/ApiKeys";
import { ConsolePage } from "@/ui/ConsoleShell";

export default function KeysPage() {
  return (
    <ConsolePage active="keys" title="API Keys">
      <ApiKeysView />
    </ConsolePage>
  );
}
