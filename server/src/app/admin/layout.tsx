import "@/admin/admin.css";

import { type Metadata } from "next";

import { AdminShell } from "@/admin/AdminShell";

export const metadata: Metadata = {
  title: "fs-server · admin",
  description: "Operations console for the fs file-hosting server",
};

export default function AdminLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return <AdminShell>{children}</AdminShell>;
}
