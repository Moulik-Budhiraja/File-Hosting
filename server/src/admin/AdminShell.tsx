"use client";

import { usePathname } from "next/navigation";
import { useEffect, useId, useState } from "react";

import { adminApi, useToken } from "./client";
import { authStore } from "./auth-store";
import { NavRail, type NavHealth } from "./components/NavRail";

function TokenGate() {
  const inputId = useId();
  const [value, setValue] = useState("");

  return (
    <main className="token-gate">
      <form
        className="token-form"
        onSubmit={(event) => {
          event.preventDefault();
          authStore.setToken(value);
        }}
      >
        <h1>Authentication required</h1>
        <p className="token-note">
          Enter the shared bearer token (<code>FS_TOKEN</code>). It is held in
          memory for this tab only — never stored — and a reload will ask again.
        </p>
        <label htmlFor={inputId}>Bearer token</label>
        <input
          id={inputId}
          type="password"
          autoComplete="off"
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
        <button type="submit" className="button button-primary">
          Unlock console
        </button>
      </form>
    </main>
  );
}

export function AdminShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? "/admin";
  const token = useToken();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [health, setHealth] = useState<NavHealth | null>(null);
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const result = await adminApi.getHealth();
        if (!cancelled)
          setHealth({ label: "GET /healthz 200", ok: result.status === "ok" });
      } catch {
        if (!cancelled)
          setHealth({ label: "GET /healthz unreachable", ok: false });
      }
    }
    void poll();
    const timer = setInterval(() => void poll(), 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (!token) {
      setVersion(null);
      return;
    }
    let cancelled = false;
    adminApi
      .getSystem()
      .then((system) => {
        if (!cancelled) setVersion(system.version);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [token]);

  return (
    <div className="admin-root">
      <NavRail
        activeRoute={pathname}
        health={health}
        version={version}
        mobileOpen={mobileOpen}
        onToggleMobile={() => setMobileOpen((open) => !open)}
      />
      {token ? children : <TokenGate />}
    </div>
  );
}
