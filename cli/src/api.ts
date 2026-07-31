import type { Readable } from "node:stream";
import { CliError, EXIT } from "./errors.js";
import type { Config } from "./config.js";
import type { FileMetadata, FilePage } from "./types.js";

interface ErrorEnvelope {
  error?: { code?: string; message?: string };
}

export interface ListParams {
  q?: string;
  name?: string;
  tags?: string[];
  visibility?: "public" | "protected" | "private";
  limit?: number;
  cursor?: string;
}

export class ApiClient {
  constructor(
    private readonly config: Config,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  private url(path: string, query?: URLSearchParams): URL {
    const url = new URL(path, `${this.config.baseUrl}/`);
    if (query) url.search = query.toString();
    return url;
  }

  private headers(extra?: HeadersInit): Headers {
    const headers = new Headers(extra);
    if (this.config.token) headers.set("authorization", `Bearer ${this.config.token}`);
    return headers;
  }

  private async perform(url: URL, init: RequestInit = {}): Promise<Response> {
    try {
      return await this.fetchFn(url, { ...init, headers: this.headers(init.headers) });
    } catch (error) {
      throw new CliError(
        `Could not reach ${url.origin}: ${error instanceof Error ? error.message : String(error)}`,
        EXIT.network,
        "NETWORK_ERROR",
      );
    }
  }

  private async checked(url: URL, init: RequestInit = {}): Promise<Response> {
    const response = await this.perform(url, init);
    if (response.ok) return response;

    let envelope: ErrorEnvelope = {};
    try {
      envelope = (await response.json()) as ErrorEnvelope;
    } catch {
      // An upstream proxy may return HTML; keep the status-based message.
    }
    const message = envelope.error?.message || `Server returned HTTP ${response.status}`;
    const code = envelope.error?.code || `HTTP_${response.status}`;
    if (response.status === 401 || response.status === 403) {
      throw new CliError(message, EXIT.auth, code);
    }
    if (response.status === 400 || response.status === 422) {
      throw new CliError(message, EXIT.usage, code);
    }
    if (response.status === 404) throw new CliError(message, EXIT.notFound, code);
    if (response.status === 409) throw new CliError(message, EXIT.conflict, code);
    throw new CliError(message, EXIT.network, code);
  }

  async upload(input: {
    name: string;
    size: number;
    stream: Readable;
    tags: string[];
    private: boolean;
    archive: "tar.gz" | null;
  }): Promise<FileMetadata> {
    const query = new URLSearchParams({ name: input.name });
    for (const tag of input.tags) query.append("tag", tag);
    if (input.private) query.set("private", "true");
    if (input.archive) query.set("archive", input.archive);
    const response = await this.checked(this.url("/api/files", query), {
      method: "POST",
      headers: { "content-length": String(input.size), "content-type": "application/octet-stream" },
      body: input.stream as unknown as BodyInit,
      // Required by Node when a request body is a stream.
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const body = (await response.json()) as FileMetadata | { file: FileMetadata };
    return "file" in body ? body.file : body;
  }

  async list(params: ListParams): Promise<FilePage> {
    const query = new URLSearchParams();
    if (params.q) query.set("q", params.q);
    if (params.name) query.set("name", params.name);
    for (const tag of params.tags ?? []) query.append("tag", tag);
    if (params.visibility) query.set("visibility", params.visibility);
    if (params.limit !== undefined) query.set("limit", String(params.limit));
    if (params.cursor) query.set("cursor", params.cursor);
    const response = await this.checked(this.url("/api/files", query));
    const page = (await response.json()) as FilePage;
    return { items: page.items ?? [], next_cursor: page.next_cursor ?? null };
  }

  async info(id: string): Promise<FileMetadata> {
    const response = await this.checked(this.url(`/api/files/${encodeURIComponent(id)}`));
    const body = (await response.json()) as FileMetadata | { file: FileMetadata };
    return "file" in body ? body.file : body;
  }

  async patch(
    id: string,
    body: {
      tags?: { operation: "add" | "remove" | "set"; values: string[] };
      visibility?: "public" | "protected" | "private";
    },
  ): Promise<FileMetadata> {
    const response = await this.checked(this.url(`/api/files/${encodeURIComponent(id)}`), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const value = (await response.json()) as FileMetadata | { file: FileMetadata };
    return "file" in value ? value.file : value;
  }

  async delete(id: string): Promise<void> {
    await this.checked(this.url(`/api/files/${encodeURIComponent(id)}`), { method: "DELETE" });
  }

  async raw(id: string): Promise<Response> {
    return this.checked(this.url(`/raw/${encodeURIComponent(id)}`));
  }

  previewUrl(id: string): string {
    return `${this.config.baseUrl}/${encodeURIComponent(id)}`;
  }

  rawUrl(id: string): string {
    return `${this.config.baseUrl}/raw/${encodeURIComponent(id)}`;
  }
}
