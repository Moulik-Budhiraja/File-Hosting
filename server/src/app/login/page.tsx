"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";

import { markSessionActive } from "@/lib/auth-context";
import { publishSessionChange } from "@/lib/session-signal";
import { sanitizeNextPath } from "@/lib/next-path";
import { safeStorageGet, safeStorageSet } from "@/lib/safe-storage";
import { LoginForm, type LoginNotice } from "@/ui/LoginForm";

const LAST_USERNAME_KEY = "fs.last-username";

function LoginScreen() {
  const router = useRouter();
  const params = useSearchParams();
  const notice: LoginNotice | undefined =
    params.get("changed") === "1"
      ? "password-changed"
      : params.get("expired") === "1"
        ? "session-expired"
        : undefined;
  const nextPath = sanitizeNextPath(params.get("next"));
  const [initialUsername, setInitialUsername] = useState<string | null>(
    notice === "session-expired" ? null : "",
  );

  useEffect(() => {
    if (notice !== "session-expired") return;
    // The username is not a secret; it lets re-authentication return to the
    // prior task with one field already filled. Restricted storage just
    // degrades to an empty field.
    setInitialUsername(safeStorageGet(LAST_USERNAME_KEY) ?? "");
  }, [notice]);

  if (initialUsername === null) return null;

  return (
    <div className="login-shell">
      <header className="login-shell-header">
        <span className="nav-product-name">fs-server</span>
      </header>
      <main className="login-main">
        <LoginForm
          notice={notice}
          initialUsername={initialUsername}
          onSuccess={(user) => {
            safeStorageSet(LAST_USERNAME_KEY, user.username);
            markSessionActive();
            // Every successful login (including replacing an existing
            // session with another account) publishes a CHANGED version so
            // other tabs refresh immediately.
            publishSessionChange();
            router.replace(nextPath);
          }}
        />
      </main>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginScreen />
    </Suspense>
  );
}
