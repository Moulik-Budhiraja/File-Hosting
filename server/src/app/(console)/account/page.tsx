"use client";

import { useRouter } from "next/navigation";

import { AccountSecurity } from "@/ui/AccountSecurity";
import { ConsolePage } from "@/ui/ConsoleShell";

export default function AccountPage() {
  const router = useRouter();
  return (
    <ConsolePage active="account" title="Account">
      <AccountSecurity
        onPasswordChanged={() => {
          // Every session (including this one) was revoked by the change.
          // Land on the truthful password-changed login state and return
          // here after re-auth.
          router.replace("/login?changed=1&next=%2Faccount");
        }}
      />
    </ConsolePage>
  );
}
