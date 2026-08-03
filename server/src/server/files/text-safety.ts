const CONTROL_PATTERN = /[\u0000-\u001F\u007F-\u009F]/gu;
const WHITESPACE_TO_SPACE = /[\t\r\n\u2028\u2029]/gu;
const BIDI_CONTROLS = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;
const INVALID_UNICODE = /[\uD800-\uDFFF\uFFFD]|\p{Noncharacter_Code_Point}/gu;
const UNSAFE_DISPLAY_TEXT =
  /[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069\uD800-\uDFFF\uFFFD]|\p{Noncharacter_Code_Point}/u;

export function hasUnsafeDisplayText(value: string): boolean {
  return UNSAFE_DISPLAY_TEXT.test(value);
}

export function sanitizePublicText(value: string, maxBytes: number): string {
  const cleaned = value
    .normalize("NFC")
    .replace(WHITESPACE_TO_SPACE, " ")
    .replace(CONTROL_PATTERN, "")
    .replace(BIDI_CONTROLS, "")
    .replace(INVALID_UNICODE, "")
    .replace(/ {2,}/gu, " ")
    .trim();

  let bytes = 0;
  let end = 0;
  for (const character of cleaned) {
    bytes += Buffer.byteLength(character, "utf8");
    if (bytes > maxBytes) break;
    end += character.length;
  }
  return cleaned.slice(0, end).trim();
}

const ENCODED_OCTET = /%[0-9a-f]{2}/iu;
const LOCATOR =
  /(?:[a-z][a-z0-9+.-]{0,31}\s*:|(?:https?:)?\/\/|www\.|(?:localhost|(?:\d{1,3}\.){3}\d{1,3})(?::\d+)?|[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,62}\.)+(?:com|net|org|dev|io|app|co|me|ai|xyz|test|invalid|local|md|so|ts)(?:[\/:?#]|\b)|[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}|(?:^|[^\p{L}\p{N}])[/?#][^\s]*|\\\\|[\p{L}\p{N}._-]+[\\/][\p{L}\p{N}._/?#-]+)/iu;

const SAFE_FILENAME_EXTENSION =
  /\.(?:md|txt|png|jpe?g|gif|webp|avif|pdf|zip|tar|gz|tgz|mp3|wav|flac|m4a|mp4|mov|webm|csv|json|ya?ml|js|jsx|ts|tsx|py|html|css|docx?|xlsx?|pptx?)$/iu;
const UNSAFE_FILENAME_CHARACTER = /[\\/?#&=:]|[\p{Cc}\p{Cs}]/u;
const QUERY_ASSIGNMENT = /\?[^\s]*[=&][^\s]*/u;
const SANITIZED_SCHEME = /^(?:https?|ftp|file)[-_]/iu;

function isSafeFilename(token: string): boolean {
  return (
    SAFE_FILENAME_EXTENSION.test(token) &&
    !UNSAFE_FILENAME_CHARACTER.test(token)
  );
}

function isLocatorToken(token: string): boolean {
  return (
    QUERY_ASSIGNMENT.test(token) ||
    SANITIZED_SCHEME.test(token) ||
    (!isSafeFilename(token) && LOCATOR.test(token))
  );
}

function locatorProbe(value: string): {
  decoded: string;
  unsafeEncoding: boolean;
} {
  let decoded = value
    .replace(/[。．｡]/gu, ".")
    .replace(CONTROL_PATTERN, "")
    .replace(BIDI_CONTROLS, "");
  for (let pass = 0; pass < 4 && ENCODED_OCTET.test(decoded); pass += 1) {
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      return { decoded, unsafeEncoding: true };
    }
    decoded = decoded
      .replace(/[。．｡]/gu, ".")
      .replace(CONTROL_PATTERN, "")
      .replace(BIDI_CONTROLS, "");
  }
  return { decoded, unsafeEncoding: ENCODED_OCTET.test(decoded) };
}

export function sanitizeExcerptLine(value: string, maxBytes: number): string {
  const leading = /^(?: {1,8}|\t{1,2})/u.exec(value)?.[0] ?? "";
  const normalized = value
    .normalize("NFC")
    .replaceAll("\t", "    ")
    .replace(CONTROL_PATTERN, "")
    .replace(BIDI_CONTROLS, "")
    .replace(INVALID_UNICODE, "");
  const structuralPrefix =
    /^( {0,3}(?:#{1,6}|[-*•]))\s+/u.exec(normalized)?.[0] ?? "";
  const probe = locatorProbe(normalized.slice(structuralPrefix.length));
  if (probe.unsafeEncoding) return "";
  const scrubbed = probe.decoded
    .split(/(\s+)/u)
    .filter((token) => /^\s+$/u.test(token) || !isLocatorToken(token))
    .join("")
    .trimEnd();
  const indentation = structuralPrefix
    ? ""
    : leading.replaceAll("\t", "    ").slice(0, 8);
  const body = scrubbed.trimStart();
  const cleaned = `${structuralPrefix || indentation}${body}`;
  let bytes = 0;
  let output = "";
  for (const { segment } of new Intl.Segmenter(undefined, {
    granularity: "grapheme",
  }).segment(cleaned)) {
    const next = Buffer.byteLength(segment, "utf8");
    if (bytes + next > maxBytes) break;
    output += segment;
    bytes += next;
  }
  return output;
}

export function sanitizeLocatorFreeText(
  value: string,
  maxBytes: number,
  fallback = "",
): string {
  const sanitized = sanitizePublicText(value, maxBytes * 2);
  const probe = locatorProbe(sanitized);
  if (probe.unsafeEncoding) return sanitizePublicText(fallback, maxBytes);
  const kept = probe.decoded
    .split(/\s+/u)
    .filter((token) => !isLocatorToken(token))
    .join(" ")
    .replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu, "");
  return sanitizePublicText(kept || fallback, maxBytes);
}
