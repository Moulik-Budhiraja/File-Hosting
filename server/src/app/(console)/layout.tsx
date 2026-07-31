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
      const params = new URLSearchParams();
      params.set("next", pathname || "/files");
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
