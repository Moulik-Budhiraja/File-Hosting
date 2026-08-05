import { AccountSecurity } from "@/ui/AccountSecurity";
import { ConsolePage } from "@/ui/ConsoleShell";

export default function AccountPage() {
  return (
    <ConsolePage active="account" title="Account">
      <AccountSecurity />
    </ConsolePage>
  );
}
