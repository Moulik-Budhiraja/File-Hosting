const REQUEST_ID_RECOVERY =
  "Secure request IDs are unavailable. Use HTTPS or a supported browser.";

export class RequestIdUnavailableError extends Error {
  constructor() {
    super(REQUEST_ID_RECOVERY);
    this.name = "RequestIdUnavailableError";
  }
}

export function newRequestId(): string {
  const browserCrypto = globalThis.crypto;
  if (typeof browserCrypto?.randomUUID === "function") {
    return browserCrypto.randomUUID();
  }
  if (typeof browserCrypto?.getRandomValues !== "function") {
    throw new RequestIdUnavailableError();
  }

  const bytes = new Uint8Array(16);
  browserCrypto.getRandomValues(bytes);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
