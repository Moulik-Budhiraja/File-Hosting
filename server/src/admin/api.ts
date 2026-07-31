// Thin typed client over the real server API. Errors are classified so views
// can render truthful auth / API / disconnected states.

export type ErrorKind = "auth" | "api" | "disconnected";

export class AdminApiError extends Error {
  constructor(
    readonly kind: ErrorKind,
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "AdminApiError";
  }
}

export interface FileEntry {
  id: string;
  name: string;
  size: number;
  mime_type: string;
  sha256: string;
  visibility: "public" | "private";
  tags: string[];
  preview_url: string;
  raw_url: string;
  archive: "tar.gz" | null;
  created_at: string;
  updated_at: string;
}

export interface ListFilesResponse {
  items: FileEntry[];
  next_cursor: string | null;
}

export interface HealthResponse {
  status: string;
  free_bytes: number;
}

export interface SystemResponse {
  version: string;
  node: string;
  uptime_seconds: number;
  storage: {
    free_bytes: number;
    object_bytes: number;
    object_count: number;
    public_count: number;
    private_count: number;
    temp_part_count: number;
  };
  database: { db_bytes: number | null };
  // CURRENT in-flight transfers for the responding server process only.
  transfers: {
    direction: "upload" | "download";
    name: string;
    bytes: number;
    total_bytes: number | null;
    started_at: string;
  }[];
  config: {
    max_upload_bytes: number;
    min_free_bytes: number;
    public_url: string;
  };
}

export interface FilesQuery {
  q?: string;
  name?: string;
  tags?: string[];
  visibility?: "public" | "private";
  archive?: "tar.gz" | "none";
  limit: number;
  cursor?: string;
}

export function buildFilesQuery(query: FilesQuery): string {
  const params = new URLSearchParams();
  if (query.q) params.set("q", query.q);
  if (query.name) params.set("name", query.name);
  for (const tag of query.tags ?? []) params.append("tag", tag);
  if (query.visibility) params.set("visibility", query.visibility);
  if (query.archive) params.set("archive", query.archive);
  params.set("limit", String(query.limit));
  if (query.cursor) params.set("cursor", query.cursor);
  return params.toString();
}

export interface TagsPatch {
  operation: "add" | "remove" | "set";
  values: string[];
}

export interface FilePatch {
  visibility?: "public" | "private";
  tags?: TagsPatch;
}

interface AdminApiOptions {
  fetchImpl?: typeof fetch;
  getToken: () => string | null;
  baseUrl?: string;
}

export interface AdminApi {
  getHealth(): Promise<HealthResponse>;
  getSystem(): Promise<SystemResponse>;
  listFiles(query: FilesQuery): Promise<ListFilesResponse>;
  getFile(id: string): Promise<FileEntry>;
  updateFile(id: string, patch: FilePatch): Promise<FileEntry>;
  deleteFile(id: string): Promise<void>;
  uploadFile(
    body: Blob,
    options: {
      name: string;
      tags: string[];
      visibility: "public" | "private";
      archive?: "tar.gz";
    },
  ): Promise<FileEntry>;
  fetchRawText(
    id: string,
    maxBytes: number,
    options?: { signal?: AbortSignal },
  ): Promise<string>;
  fetchRawBlob(id: string, options?: { signal?: AbortSignal }): Promise<Blob>;
  fetchRawStream(
    id: string,
    options?: { signal?: AbortSignal },
  ): Promise<Response>;
}

async function readErrorMessage(response: Response): Promise<{
  message: string;
  code?: string;
}> {
  try {
    const body = (await response.json()) as {
      error?: { code?: string; message?: string };
    };
    if (body.error?.message)
      return { message: body.error.message, code: body.error.code };
  } catch {
    // Fall through to the generic message.
  }
  return { message: `Request failed with status ${response.status}` };
}

export function createAdminApi(options: AdminApiOptions): AdminApi {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl ?? "";

  async function request(
    path: string,
    init: RequestInit & { auth?: boolean } = {},
  ): Promise<Response> {
    const { auth = true, ...rest } = init;
    const headers = new Headers(rest.headers);
    if (auth) {
      const token = options.getToken();
      if (!token) {
        throw new AdminApiError("auth", "A bearer token is required");
      }
      headers.set("authorization", `Bearer ${token}`);
    }
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, { ...rest, headers });
    } catch (error) {
      // An aborted request is the caller's own cancellation, not a
      // connectivity failure — surface it unchanged.
      if (error instanceof Error && error.name === "AbortError") throw error;
      throw new AdminApiError("disconnected", "Could not reach the server");
    }
    if (!response.ok) {
      const { message, code } = await readErrorMessage(response);
      const kind: ErrorKind = response.status === 401 ? "auth" : "api";
      throw new AdminApiError(kind, message, response.status, code);
    }
    return response;
  }

  return {
    async getHealth() {
      const response = await request("/healthz", { auth: false });
      return (await response.json()) as HealthResponse;
    },
    async getSystem() {
      const response = await request("/api/system");
      return (await response.json()) as SystemResponse;
    },
    async listFiles(query) {
      const response = await request(`/api/files?${buildFilesQuery(query)}`);
      return (await response.json()) as ListFilesResponse;
    },
    async getFile(id) {
      const response = await request(`/api/files/${id}`);
      return (await response.json()) as FileEntry;
    },
    async updateFile(id, patch) {
      const response = await request(`/api/files/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      return (await response.json()) as FileEntry;
    },
    async deleteFile(id) {
      await request(`/api/files/${id}`, { method: "DELETE" });
    },
    async uploadFile(body, uploadOptions) {
      // Metadata travels percent-encoded in x-fs-* headers so filenames and
      // tags never enter the request URL (and any access logs of it).
      const headers: Record<string, string> = {
        "x-fs-name": encodeURIComponent(uploadOptions.name),
      };
      if (uploadOptions.tags.length > 0) {
        headers["x-fs-tags"] = uploadOptions.tags
          .map((tag) => encodeURIComponent(tag))
          .join(",");
      }
      if (uploadOptions.visibility === "private")
        headers["x-fs-private"] = "true";
      if (uploadOptions.archive)
        headers["x-fs-archive"] = uploadOptions.archive;
      const response = await request("/api/files", {
        method: "POST",
        headers,
        body,
      });
      return (await response.json()) as FileEntry;
    },
    async fetchRawText(id, maxBytes, fetchOptions = {}) {
      const response = await request(`/raw/${id}`, {
        // A range of "bytes=0--1" would be malformed; zero-byte objects are
        // fetched without a range header and yield an empty string.
        headers:
          maxBytes > 0 ? { range: `bytes=0-${maxBytes - 1}` } : undefined,
        signal: fetchOptions.signal,
      });
      return response.text();
    },
    async fetchRawBlob(id, fetchOptions = {}) {
      const response = await request(`/raw/${id}`, {
        signal: fetchOptions.signal,
      });
      return response.blob();
    },
    async fetchRawStream(id, fetchOptions = {}) {
      return request(`/raw/${id}`, { signal: fetchOptions.signal });
    },
  };
}
