"use client";

import Link from "next/link";

import { useAuth } from "@/lib/auth-context";
import { ConsolePage } from "@/ui/ConsoleShell";

export default function MorePage() {
  const { isAdmin } = useAuth();
  return (
    <ConsolePage active="more" title="More">
      <nav className="more-links" aria-label="More console pages">
        {isAdmin ? (
          <>
            <Link className="button button-block" href="/users">
              Users
            </Link>
            <Link className="button button-block" href="/keys">
              API Keys
            </Link>
          </>
        ) : null}
        <Link className="button button-block" href="/account">
          Account
        </Link>
      </nav>
    </ConsolePage>
  );
}
