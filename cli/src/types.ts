export interface FileMetadata {
  id: string;
  name: string;
  size: number;
  mime_type?: string | null;
  sha256?: string | null;
  visibility: "public" | "private";
  tags: string[];
  archive: "tar.gz" | null;
  created_at?: string;
  updated_at?: string;
  preview_url?: string;
  raw_url?: string;
}

export interface FilePage {
  items: FileMetadata[];
  next_cursor: string | null;
}

export interface Streams {
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}
