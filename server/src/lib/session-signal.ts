// Cross-tab session-change signal. Every authentication transition
// (login, session replacement, logout) publishes a fresh non-secret
// version value through guarded localStorage — the value CHANGES each
// time, because writing an identical value would suppress the storage
// event entirely — and through BroadcastChannel where available. Other
// tabs refresh their identity immediately, focused or not.

import { safeStorageSet } from "@/lib/safe-storage";

export const SESSION_VERSION_KEY = "fs.session-version";
const CHANNEL_NAME = "fs.session";

function newSessionVersion(): string {
  try {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
      "",
    );
  } catch {
    // Non-secret marker: uniqueness matters, unpredictability does not.
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

function openChannel(): BroadcastChannel | null {
  try {
    if (typeof BroadcastChannel === "undefined") return null;
    return new BroadcastChannel(CHANNEL_NAME);
  } catch {
    return null;
  }
}

export function publishSessionChange(): void {
  const version = newSessionVersion();
  safeStorageSet(SESSION_VERSION_KEY, version);
  const channel = openChannel();
  if (channel) {
    try {
      channel.postMessage({ type: "session-change", version });
    } catch {
      // Restricted messaging degrades to the storage signal.
    }
    channel.close();
  }
}

export function subscribeSessionChange(listener: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === SESSION_VERSION_KEY) listener();
  };
  window.addEventListener("storage", onStorage);
  const channel = openChannel();
  if (channel) channel.onmessage = () => listener();
  return () => {
    window.removeEventListener("storage", onStorage);
    channel?.close();
  };
}
