"use client";

import { AdminGate, ConsolePage } from "@/ui/ConsoleShell";
import { UsersDirectory } from "@/ui/UsersDirectory";

export default function UsersPage() {
  return (
    <ConsolePage active="users" title="Users">
      <AdminGate>
        <UsersDirectory />
      </AdminGate>
    </ConsolePage>
  );
}
