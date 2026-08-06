export const BASE62_ID_PATTERN = /^[0-9A-Za-z]{7}$/;

export type Visibility = "public" | "protected" | "private";
export type AccessRole = "anonymous" | "admin" | "member";
export interface AccessScope {
  role: AccessRole;
  userId: string | null;
}
export type ArchiveType = "tar.gz" | null;

export interface StoredFile {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  sha256: string;
  visibility: Visibility;
  ownerId: string | null;
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
  owner_id: string | null;
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
  archive?: "tar.gz" | "none";
  /** Restrict to files owned by this user id — applied in SQL before
   * cursor pagination so filtered pages and empties are truthful. */
  owner?: string;
  limit: number;
  cursor?: { createdAt: string; id: string };
  access?: AccessScope;
}

export interface ListFilesResult {
  files: StoredFile[];
  nextCursor: string | null;
}

export interface UploadOptions {
  name: string;
  tags: string[];
  visibility: Visibility;
  ownerId?: string | null;
  archive: ArchiveType;
  mimeType?: string;
  contentLength?: number;
  authorizeFinalize?: () => Promise<void> | void;
}

export type TagOperation = "add" | "remove" | "set";
