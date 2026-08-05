// localStorage access can throw synchronously (private mode, storage
// partitioning, enterprise policy) — even reading window.localStorage
// itself. Every touch point goes through these guards so restricted
// storage degrades features instead of crashing the page.

export function safeStorageGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function safeStorageSet(key: string, value: string): boolean {
  try {
    window.localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function safeStorageRemove(key: string): boolean {
  try {
    window.localStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}
