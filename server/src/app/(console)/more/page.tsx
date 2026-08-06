"use client";

import Link from "next/link";

import { ConsolePage } from "@/ui/ConsoleShell";

export default function MorePage() {
  return (
    <ConsolePage active="more" title="More">
      <nav className="more-links" aria-label="More console pages">
        <Link className="button button-block" href="/users">
          Users
        </Link>
        <Link className="button button-block" href="/keys">
          API Keys
        </Link>
        <Link className="button button-block" href="/account">
          Account
        </Link>
      </nav>
    </ConsolePage>
  );
}
