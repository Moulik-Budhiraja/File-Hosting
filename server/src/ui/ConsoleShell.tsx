"use client";

import Link from "next/link";

import { useAuth } from "@/lib/auth-context";

export type ConsoleSection =
  "overview" | "files" | "system" | "users" | "keys" | "account" | "more";

const NAV_ITEMS: Array<{
  key: ConsoleSection;
  label: string;
  href: string;
  adminOnly?: boolean;
  mobileOnly?: boolean;
  mobileHidden?: boolean;
}> = [
  { key: "overview", label: "Overview", href: "/overview", adminOnly: true },
  { key: "files", label: "Files", href: "/files" },
  { key: "system", label: "System", href: "/system", adminOnly: true },
  {
    key: "users",
    label: "Users",
    href: "/users",
    adminOnly: true,
    mobileHidden: true,
  },
  { key: "keys", label: "API Keys", href: "/keys", mobileHidden: true },
  { key: "account", label: "Account", href: "/account", mobileHidden: true },
  { key: "more", label: "More", href: "/more", mobileOnly: true },
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
            (item) => {
              const isActive =
                item.key === active ||
                (item.key === "more" &&
                  (active === "users" ||
                    active === "keys" ||
                    active === "account"));
              return (
                <li
                  key={item.key}
                  className={
                    item.mobileOnly
                      ? "nav-mobile-only"
                      : item.mobileHidden
                        ? "nav-mobile-hidden"
                        : undefined
                  }
                >
                  <Link
                    href={item.href}
                    className={`nav-item${isActive ? " nav-item-active" : ""}`}
                    aria-current={isActive ? "page" : undefined}
                  >
                    {item.label}
                  </Link>
                </li>
              );
            },
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
  embeddedHeader?: boolean;
}

export function ConsolePage({
  active,
  title,
  actions,
  children,
  embeddedHeader = false,
}: ConsolePageProps) {
  return (
    <div className="console">
      <ConsoleNav active={active} />
      <main className="console-main">
        {embeddedHeader ? null : (
          <header className="page-header">
            <div className="page-header-text">
              <h1 className="page-title">{title}</h1>
            </div>
            <div className="page-header-side">{actions}</div>
          </header>
        )}
        {children}
      </main>
    </div>
  );
}
