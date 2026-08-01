import { AppError } from "./errors";
import { hasUnsafeDisplayText } from "./text-safety";
import { BASE62_ID_PATTERN, type ArchiveType, type Visibility } from "./types";
export function validateId(id: string): string {
  if (!BASE62_ID_PATTERN.test(id)) {
    throw new AppError(
      400,
      "invalid_id",
      "File ID must be a 7-character base62 value",
    );
  }
  return id;
}

export function validateFilename(name: string | null): string {
  if (name === null)
    throw new AppError(
      400,
      "invalid_name",
      "The name query parameter is required",
    );
  const value = name.trim();
  if (!value || value === "." || value === "..") {
    throw new AppError(400, "invalid_name", "File name cannot be empty");
  }
  if (Buffer.byteLength(value, "utf8") > 255) {
    throw new AppError(
      400,
      "invalid_name",
      "File name cannot exceed 255 UTF-8 bytes",
    );
  }
  if (value.includes("\uFFFD") || /\p{Noncharacter_Code_Point}/u.test(value)) {
    throw new AppError(
      400,
      "invalid_name",
      "File name contains invalid Unicode scalar values",
    );
  }
  if (
    hasUnsafeDisplayText(value) ||
    value.includes("/") ||
    value.includes("\\")
  ) {
    throw new AppError(
      400,
      "invalid_name",
      "File name cannot contain path separators or control characters",
    );
  }
  return value;
}

export function validateTags(input: readonly unknown[]): string[] {
  if (input.length > 20)
    throw new AppError(400, "invalid_tags", "At most 20 tags are allowed");

  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of input) {
    if (typeof raw !== "string")
      throw new AppError(400, "invalid_tags", "Tags must be strings");
    const tag = raw.trim();
    if (
      !tag ||
      Buffer.byteLength(tag, "utf8") > 64 ||
      hasUnsafeDisplayText(tag) ||
      tag.includes(",")
    ) {
      throw new AppError(
        400,
        "invalid_tags",
        "Tags must be 1-64 UTF-8 bytes and cannot contain commas or control characters",
      );
    }
    const key = tag.toLocaleLowerCase("en-US");
    if (!seen.has(key)) {
      seen.add(key);
      result.push(tag);
    }
  }
  return result;
}

export function parseVisibility(
  value: unknown,
  fallback?: Visibility,
): Visibility {
  if (value === undefined || value === null || value === "") {
    if (fallback) return fallback;
    throw new AppError(
      400,
      "invalid_visibility",
      "Visibility must be public, protected, or private",
    );
  }
  if (value !== "public" && value !== "protected" && value !== "private") {
    throw new AppError(
      400,
      "invalid_visibility",
      "Visibility must be public, protected, or private",
    );
  }
  return value;
}

export function parseArchive(value: string | null): ArchiveType {
  if (value === null || value === "") return null;
  if (value !== "tar.gz") {
    throw new AppError(
      400,
      "invalid_archive",
      "Archive must be tar.gz when provided",
    );
  }
  return value;
}

export function parseBoolean(value: string | null, fallback = false): boolean {
  if (value === null || value === "") return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new AppError(
    400,
    "invalid_boolean",
    "Boolean query parameters must be true or false",
  );
}

export function parseLimit(value: string | null): number {
  if (value === null || value === "") return 100;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 500) {
    throw new AppError(
      400,
      "invalid_limit",
      "Limit must be an integer between 1 and 500",
    );
  }
  return parsed;
}
