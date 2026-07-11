export const BASE62_ID_PATTERN = /^[0-9A-Za-z]{7}$/;

export type Visibility = "public" | "private";
export type ArchiveType = "tar.gz" | null;

export interface StoredFile {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  sha256: string;
  visibility: Visibility;
  storageKey: string;
  archive: ArchiveType;
  createdAt: string;
  updatedAt: string;
  tags: string[];
}

export interface FileMetadata {
  id: string;
  name: string;
  size: number;
  mime_type: string;
  sha256: string;
  visibility: Visibility;
  tags: string[];
  preview_url: string;
  raw_url: string;
  archive: ArchiveType;
  created_at: string;
  updated_at: string;
}

export interface ListFilesOptions {
  q?: string;
  name?: string;
  tags: string[];
  visibility?: Visibility;
  limit: number;
  cursor?: { createdAt: string; id: string };
}

export interface ListFilesResult {
  files: StoredFile[];
  nextCursor: string | null;
}

export interface UploadOptions {
  name: string;
  tags: string[];
  visibility: Visibility;
  archive: ArchiveType;
  mimeType?: string;
  contentLength?: number;
}

export type TagOperation = "add" | "remove" | "set";
