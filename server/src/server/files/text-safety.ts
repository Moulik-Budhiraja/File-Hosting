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
const ABSOLUTE_LOCATOR =
  /^(?:[a-z][a-z0-9+.-]{0,31}:\/\/|(?:https?:)?\/\/|www\.)/iu;
const EMBEDDED_ABSOLUTE_LOCATOR =
  /(?:[a-z][a-z0-9+.-]{0,31}:\/\/|(?:https?:)?\/\/|www\.)/iu;
const LOCAL_LOCATOR =
  /^(?:localhost|(?:\d{1,3}\.){3}\d{1,3})(?::\d+)?(?:[\/:?#]|$)/iu;
const EMAIL_LOCATOR =
  /^[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}(?:\p{P})?$/iu;
const PATH_LOCATOR =
  /^(?:\/(?:[^#?\s]*[\\/]|[^\s]*[?#]|[^\s]+)|\\\\[^\s]+|[a-z]:[\\/][^\s]+|[A-Za-z0-9._-]+[\\/][^#?\s]*)$/iu;
const DOMAIN_SUFFIXES = new Set([
  "com",
  "net",
  "org",
  "dev",
  "io",
  "app",
  "co",
  "me",
  "ai",
  "xyz",
  "test",
  "invalid",
  "local",
]);

const SAFE_FILENAME_EXTENSION =
  /\.(?:md|txt|png|jpe?g|gif|webp|avif|pdf|zip|tar|gz|tgz|mp3|wav|flac|m4a|mp4|mov|webm|csv|json|ya?ml|js|jsx|ts|tsx|py|html|css|docx?|xlsx?|pptx?)$/iu;
const UNSAFE_FILENAME_CHARACTER = /[\\/?#&=:]|[\p{Cc}\p{Cs}]/u;
const QUERY_ASSIGNMENT = /\?[^\s]*[=&][^\s]*/u;
const DEFANGED_SCHEME_LOCATOR =
  /^(?:https?|ftp|file)[-_][^\s.]+(?:\.[^\s.]+){2,}(?:[/?#][^\s]*)?$/iu;
const COLON_SCHEME_LOCATOR = /^[a-z][a-z0-9+.-]{0,31}:[^\s]+$/iu;
const QUERY_ONLY_LOCATOR = /^\?[^\s]+$/u;
const FRAGMENT_ONLY_LOCATOR = /^#[a-z][a-z0-9._~-]{4,}$/iu;

function isSafeFilename(token: string): boolean {
  return (
    SAFE_FILENAME_EXTENSION.test(token) &&
    !UNSAFE_FILENAME_CHARACTER.test(token)
  );
}

function isLocatorToken(token: string): boolean {
  if (token.length > 2_048) return false;
  const hostname = token
    .replace(/^[([{'"`]+|[)\]}'"`,;!]+$/gu, "")
    .split(/[/:?#]/u, 1)[0]
    ?.toLocaleLowerCase();
  const labels = hostname?.split(".") ?? [];
  const domain =
    labels.length > 1 &&
    labels.every(
      (label) =>
        label.length >= 1 &&
        label.length <= 63 &&
        /^[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?$/u.test(label),
    ) &&
    DOMAIN_SUFFIXES.has(labels.at(-1) ?? "");
  return (
    DEFANGED_SCHEME_LOCATOR.test(token) ||
    COLON_SCHEME_LOCATOR.test(token) ||
    QUERY_ONLY_LOCATOR.test(token) ||
    FRAGMENT_ONLY_LOCATOR.test(token) ||
    (!isSafeFilename(token) &&
      (QUERY_ASSIGNMENT.test(token) ||
        ABSOLUTE_LOCATOR.test(token) ||
        EMBEDDED_ABSOLUTE_LOCATOR.test(token) ||
        LOCAL_LOCATOR.test(token) ||
        EMAIL_LOCATOR.test(token) ||
        PATH_LOCATOR.test(token) ||
        domain))
  );
}

function scrubExcerptToken(token: string): string {
  const markdown = token.replace(
    /(\[[^\]\s]{1,256}\])\((?:[a-z][a-z0-9+.-]{0,31}:\/\/|\/\/|www\.)[^)\s]{1,1024}\)/giu,
    "$1",
  );
  const embedded = EMBEDDED_ABSOLUTE_LOCATOR.exec(markdown);
  if (embedded && embedded.index > 0) return markdown.slice(0, embedded.index);
  return isLocatorToken(markdown) ? "" : markdown;
}

function clampForLocatorScan(value: string, maxBytes: number): string {
  const limit = Math.min(2_048, Math.max(256, maxBytes * 4));
  let bytes = 0;
  let output = "";
  for (const character of value) {
    const next = Buffer.byteLength(character, "utf8");
    if (bytes + next > limit) break;
    output += character;
    bytes += next;
  }
  return output;
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
  const bounded = clampForLocatorScan(value, maxBytes);
  const leading = /^(?: {1,32}|\t{1,8})/u.exec(bounded)?.[0] ?? "";
  const normalized = bounded
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
    .map((token) => (/^\s+$/u.test(token) ? token : scrubExcerptToken(token)))
    .join("")
    .replace(/ {2,}/gu, " ")
    .trimEnd();
  const indentation = structuralPrefix
    ? ""
    : leading.replaceAll("\t", "    ").slice(0, 32);
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
