// The shared bearer token lives only in this module's memory for the lifetime
// of the page. It is deliberately never written to localStorage, sessionStorage,
// cookies, or the URL; a reload requires re-entering it.

type Listener = () => void;

let token: string | null = null;
const listeners = new Set<Listener>();

function notify(): void {
  for (const listener of listeners) listener();
}

export const authStore = {
  getToken(): string | null {
    return token;
  },
  setToken(value: string): void {
    const trimmed = value.trim();
    token = trimmed === "" ? null : trimmed;
    notify();
  },
  clearToken(): void {
    if (token === null) return;
    token = null;
    notify();
  },
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
