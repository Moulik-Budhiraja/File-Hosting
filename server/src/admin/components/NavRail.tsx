"use client";

import Link from "next/link";
import type { ComponentType, ReactNode } from "react";

export interface NavHealth {
  label: string;
  ok: boolean;
}

const NAV_ITEMS = [
  { href: "/admin", label: "Overview" },
  { href: "/admin/files", label: "Files" },
  { href: "/admin/inspector", label: "Inspector" },
  { href: "/admin/system", label: "System" },
] as const;

interface LinkLikeProps {
  href: string;
  className?: string;
  "aria-current"?: "page";
  onClick?: () => void;
  children?: ReactNode;
}

interface NavRailProps {
  activeRoute: string;
  health: NavHealth | null;
  version: string | null;
  mobileOpen: boolean;
  onToggleMobile: () => void;
  // Injectable for tests that render outside the Next.js router.
  LinkComponent?: ComponentType<LinkLikeProps>;
}

function isActive(activeRoute: string, href: string): boolean {
  if (href === "/admin") return activeRoute === "/admin";
  return activeRoute === href || activeRoute.startsWith(`${href}/`);
}

export function NavRail({
  activeRoute,
  health,
  version,
  mobileOpen,
  onToggleMobile,
  LinkComponent = Link,
}: NavRailProps) {
  return (
    <header className="nav-rail" data-open={mobileOpen || undefined}>
      <div className="nav-product">
        <p className="nav-brand">fs-server</p>
        <p className="nav-env">
          {/* Unknown health is neutral — success green is earned, never
              assumed before the first /healthz response. */}
          <span
            className={`dot ${health === null ? "dot-muted" : health.ok ? "dot-success" : "dot-danger"}`}
            aria-hidden
          />
          admin console
        </p>
        <button
          type="button"
          className="nav-menu-button"
          aria-expanded={mobileOpen}
          aria-controls="admin-nav"
          onClick={onToggleMobile}
        >
          menu
        </button>
      </div>
      <nav aria-label="Admin" id="admin-nav" className="nav-items">
        <ul>
          {NAV_ITEMS.map((item) => {
            const active = isActive(activeRoute, item.href);
            return (
              <li key={item.href}>
                <LinkComponent
                  href={item.href}
                  className={`nav-item${active ? " nav-item-active" : ""}`}
                  aria-current={active ? "page" : undefined}
                  onClick={mobileOpen ? onToggleMobile : undefined}
                >
                  {item.label}
                </LinkComponent>
              </li>
            );
          })}
        </ul>
      </nav>
      <div className="nav-foot">
        <p>{version ? `v${version} · node` : "version unknown"}</p>
        <p className={health && !health.ok ? "text-danger" : undefined}>
          {health ? health.label : "health unchecked"}
        </p>
      </div>
    </header>
  );
}
