import {
  expect,
  request as playwrightRequest,
  type APIRequestContext,
  type BrowserContext,
  type Page,
} from "@playwright/test";

export const ADMIN = {
  username: "e2e-admin",
  password: "e2e-admin-password-longer-than-12",
};

export const LEGACY_TOKEN = "e2e-synthetic-service-token";

let ipCounter = 0;

/** Every API login uses a unique synthetic address so the backend's
 * per-address throttle never couples independent tests. */
export function nextAddress(): string {
  ipCounter += 1;
  return `10.66.${Math.floor(ipCounter / 200)}.${(ipCounter % 200) + 1}`;
}

export async function apiContext(baseURL: string): Promise<APIRequestContext> {
  return playwrightRequest.newContext({ baseURL });
}

export async function apiLoginToken(
  api: APIRequestContext,
  baseURL: string,
  username: string,
  password: string,
): Promise<string> {
  const response = await api.post("/api/auth/login", {
    data: { username, password },
    headers: { origin: baseURL, "x-real-ip": nextAddress() },
  });
  expect(response.status(), "api login should succeed").toBe(200);
  const setCookie = response.headers()["set-cookie"] ?? "";
  const match = /fs_session=([^;]+)/u.exec(setCookie);
  if (!match) throw new Error("no session cookie in login response");
  return decodeURIComponent(match[1]!);
}

export async function signInContext(
  context: BrowserContext,
  baseURL: string,
  username: string,
  password: string,
): Promise<void> {
  const api = await apiContext(baseURL);
  const token = await apiLoginToken(api, baseURL, username, password);
  await context.addCookies([
    {
      name: "fs_session",
      value: encodeURIComponent(token),
      url: baseURL,
      httpOnly: true,
      sameSite: "Strict",
    },
  ]);
  // The session marker mirrors what the login page sets in a real flow.
  await context.addInitScript(() => {
    try {
      window.localStorage.setItem("fs.session-active", "1");
    } catch {
      // Restricted-storage tests override storage anyway.
    }
  });
  await api.dispose();
}

/** Real login through the actual /login form — the flow under test for
 * cross-tab propagation. Routes a unique synthetic address so the
 * backend's per-address throttle never couples independent tests. */
export async function uiLogin(
  page: Page,
  username: string,
  password: string,
): Promise<void> {
  const address = nextAddress();
  await page.route("**/api/auth/login", (route) =>
    route.continue({
      headers: { ...route.request().headers(), "x-real-ip": address },
    }),
  );
  await page.goto("/login");
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
  await page.unroute("**/api/auth/login");
}

export interface SeededUser {
  id: string;
  username: string;
  password: string;
}

export async function ensureUser(
  baseURL: string,
  username: string,
  role: "admin" | "member",
): Promise<SeededUser> {
  const api = await apiContext(baseURL);
  const password = `${username}-fixture-password-12+`;
  const response = await api.post("/api/users", {
    data: { username, password, role },
    headers: { authorization: `Bearer ${LEGACY_TOKEN}` },
  });
  let id: string;
  if (response.status() === 201) {
    id = ((await response.json()) as { user: { id: string } }).user.id;
  } else if (response.status() === 409) {
    const list = await api.get("/api/users", {
      headers: { authorization: `Bearer ${LEGACY_TOKEN}` },
    });
    const users = (
      (await list.json()) as {
        users: Array<{ id: string; username: string }>;
      }
    ).users;
    id = users.find((user) => user.username === username)!.id;
  } else {
    throw new Error(`ensureUser ${username}: ${response.status()}`);
  }
  await api.dispose();
  return { id, username, password };
}

export async function createApiKeyFor(
  baseURL: string,
  userId: string,
  name: string,
): Promise<string> {
  const api = await apiContext(baseURL);
  const response = await api.post("/api/api-keys", {
    data: { name, user_id: userId },
    headers: { authorization: `Bearer ${LEGACY_TOKEN}` },
  });
  expect(response.status()).toBe(201);
  const secret = (
    (await response.json()) as {
      api_key: { secret: string };
    }
  ).api_key.secret;
  await api.dispose();
  return secret;
}

// Idempotent >100-row aggregate key seed shared by the search/pager and
// task-restoration specs: 12 owners × 9 keys plus one needle key created
// last (newest → beyond the first aggregate page of 100).
let aggregateSeeded = false;

async function existingKeyNames(
  baseURL: string,
  userId: string,
): Promise<Set<string>> {
  const api = await apiContext(baseURL);
  const listing = await api.get(`/api/api-keys?user_id=${userId}`, {
    headers: { authorization: `Bearer ${LEGACY_TOKEN}` },
  });
  const names = new Set(
    (
      (await listing.json()) as { api_keys: Array<{ name: string }> }
    ).api_keys.map((key) => key.name),
  );
  await api.dispose();
  return names;
}

export async function seedAggregateKeys(baseURL: string): Promise<void> {
  if (aggregateSeeded) return;
  for (let owner = 0; owner < 12; owner += 1) {
    const user = await ensureUser(baseURL, `pager-owner-${owner}`, "member");
    const existing = await existingKeyNames(baseURL, user.id);
    for (let key = 0; key < 9; key += 1) {
      const name = `pager-noise-${owner}-${key}`;
      if (existing.has(name)) continue;
      await createApiKeyFor(baseURL, user.id, name);
    }
  }
  const needleOwner = await ensureUser(baseURL, "needle-owner", "member");
  const needleExisting = await existingKeyNames(baseURL, needleOwner.id);
  if (!needleExisting.has("needle-buried-key")) {
    await createApiKeyFor(baseURL, needleOwner.id, "needle-buried-key");
  }
  aggregateSeeded = true;
}

export async function uploadFile(
  baseURL: string,
  bearer: string,
  name: string,
  visibility: "public" | "protected" | "private",
  content = "synthetic-bytes",
): Promise<{ id: string }> {
  const api = await apiContext(baseURL);
  const response = await api.post(
    `/api/files?name=${encodeURIComponent(name)}&visibility=${visibility}`,
    {
      data: content,
      headers: {
        authorization: `Bearer ${bearer}`,
        "content-type": "text/plain",
      },
    },
  );
  expect(response.status()).toBe(201);
  const body = (await response.json()) as { id: string };
  await api.dispose();
  return body;
}
