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
