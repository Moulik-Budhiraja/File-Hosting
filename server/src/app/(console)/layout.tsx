"use client";

import { usePathname, useRouter } from "next/navigation";
import { useCallback } from "react";

import { AuthProvider, type UnauthenticatedReason } from "@/lib/auth-context";

export default function ConsoleLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const router = useRouter();
  const pathname = usePathname();

  const onUnauthenticated = useCallback(
    (reason: UnauthenticatedReason) => {
      // Preserve the complete task URL (path + filters/search/page) so
      // re-authentication returns to the actual task, not just the route.
      const taskSearch =
        typeof window !== "undefined" ? window.location.search : "";
      const params = new URLSearchParams();
      params.set("next", `${pathname || "/files"}${taskSearch}`);
      if (reason === "session-expired") params.set("expired", "1");
      router.replace(`/login?${params.toString()}`);
    },
    [router, pathname],
  );

  return (
    <AuthProvider onUnauthenticated={onUnauthenticated}>
      {children}
    </AuthProvider>
  );
}
