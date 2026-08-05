"use client";

import { ConsolePage } from "@/ui/ConsoleShell";
import { FilesBrowser } from "@/ui/FilesBrowser";

export default function FilesPage() {
  return (
    <ConsolePage active="files" title="Files">
      <FilesBrowser />
    </ConsolePage>
  );
}
