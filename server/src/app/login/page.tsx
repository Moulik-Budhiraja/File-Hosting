"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";

import { markSessionActive } from "@/lib/auth-context";
import { LoginForm } from "@/ui/LoginForm";

const LAST_USERNAME_KEY = "fs.last-username";

function safeNextPath(raw: string | null): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return "/files";
  return raw;
}

function LoginScreen() {
  const router = useRouter();
  const params = useSearchParams();
  const expired = params.get("expired") === "1";
  const nextPath = safeNextPath(params.get("next"));
  const [initialUsername, setInitialUsername] = useState<string | null>(
    expired ? null : "",
  );

  useEffect(() => {
    if (!expired) return;
    // The username is not a secret; it lets re-authentication return to the
    // prior task with one field already filled.
    setInitialUsername(window.localStorage.getItem(LAST_USERNAME_KEY) ?? "");
  }, [expired]);

  if (initialUsername === null) return null;

  return (
    <div className="login-shell">
      <header className="login-shell-header">
        <span className="nav-product-name">fs-server</span>
      </header>
      <main className="login-main">
        <LoginForm
          expired={expired}
          initialUsername={initialUsername}
          onSuccess={(user) => {
            try {
              window.localStorage.setItem(LAST_USERNAME_KEY, user.username);
            } catch {
              // Private-mode storage failures never block sign-in.
            }
            markSessionActive();
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
