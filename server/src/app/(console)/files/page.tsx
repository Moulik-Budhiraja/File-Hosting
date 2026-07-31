"use client";

import { ConsolePage } from "@/ui/ConsoleShell";
import { FilesBrowser } from "@/ui/FilesBrowser";

export default function FilesPage() {
  return (
    <ConsolePage
      active="files"
      title="Files"
      subtitle="public · protected · private — visibility is the word in the row"
    >
      <FilesBrowser />
    </ConsolePage>
  );
}
