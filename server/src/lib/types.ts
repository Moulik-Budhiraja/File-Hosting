export type Role = "admin" | "member";

export interface PublicUser {
  id: string;
  username: string;
  role: Role;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface ApiKeyMetadata {
  id: string;
  user_id: string;
  name: string;
  prefix: string;
  last_four: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export type Visibility = "public" | "protected" | "private";

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
  archive: "tar.gz" | null;
  created_at: string;
  updated_at: string;
}

export interface MeResponse {
  user: PublicUser | null;
  legacy_service_credential: boolean;
  role: Role;
}
