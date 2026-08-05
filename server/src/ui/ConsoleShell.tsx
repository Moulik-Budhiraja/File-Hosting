"use client";

import Link from "next/link";

import { useAuth } from "@/lib/auth-context";

export type ConsoleSection = "files" | "users" | "keys" | "account";

const NAV_ITEMS: Array<{
  key: ConsoleSection;
  label: string;
  href: string;
  adminOnly?: boolean;
}> = [
  { key: "files", label: "Files", href: "/files" },
  { key: "users", label: "Users", href: "/users", adminOnly: true },
  { key: "keys", label: "API Keys", href: "/keys" },
  { key: "account", label: "Account", href: "/account" },
];

export function ConsoleNav({ active }: { active: ConsoleSection }) {
  const { user, isAdmin } = useAuth();
  return (
    <aside className="nav-rail">
      <div className="nav-product">
        <span className="nav-product-name">fs-server</span>
      </div>
      <nav aria-label="Console">
        <ul className="nav-items">
          {NAV_ITEMS.filter((item) => !item.adminOnly || isAdmin).map(
            (item) => (
              <li key={item.key}>
                <Link
                  href={item.href}
                  className={`nav-item${item.key === active ? " nav-item-active" : ""}`}
                  aria-current={item.key === active ? "page" : undefined}
                >
                  {item.label}
                </Link>
              </li>
            ),
          )}
        </ul>
      </nav>
      <div className="nav-foot">
        <span className="nav-foot-line">
          {user.username} · {user.role}
        </span>
      </div>
    </aside>
  );
}

export function AdminGate({ children }: { children: React.ReactNode }) {
  const { isAdmin } = useAuth();
  if (isAdmin) return <>{children}</>;
  return (
    <div className="denied-panel" role="alert">
      <p className="denied-code">403 · NOT ALLOWED</p>
      <p className="denied-title">Admin account required.</p>
      <p className="denied-detail">
        <Link href="/files">Go back</Link>
      </p>
    </div>
  );
}

interface ConsolePageProps {
  active: ConsoleSection;
  title: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}

export function ConsolePage({
  active,
  title,
  actions,
  children,
}: ConsolePageProps) {
  return (
    <div className="console">
      <ConsoleNav active={active} />
      <main className="console-main">
        <header className="page-header">
          <div className="page-header-text">
            <h1 className="page-title">{title}</h1>
          </div>
          <div className="page-header-side">{actions}</div>
        </header>
        {children}
      </main>
    </div>
  );
}
