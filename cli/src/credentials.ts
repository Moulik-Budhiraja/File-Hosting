import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { CliError, EXIT } from "./errors.js";
import type { Streams } from "./types.js";

const KEYRING_SERVICE = "dev.moulik.files.fs-cli";

export interface CredentialStore {
  getPassword(): string | null;
  setPassword(password: string): void;
  deletePassword(): boolean | void;
}

function storeError(error: unknown): CliError {
  const detail = error instanceof Error ? error.message : String(error);
  const linuxHint = process.platform === "linux"
    ? " Ensure a Secret Service-compatible keyring is installed, unlocked, and available on the session D-Bus."
    : "";
  return new CliError(
    `Could not access the operating system credential store: ${detail}.${linuxHint} Set FS_TOKEN to use an explicit environment override.`,
    EXIT.auth,
    "CREDENTIAL_STORE_UNAVAILABLE",
  );
}

export async function createCredentialStore(baseUrl: string): Promise<CredentialStore> {
  let Entry: typeof import("@napi-rs/keyring").Entry;
  try {
    ({ Entry } = await import("@napi-rs/keyring"));
  } catch (error) {
    throw storeError(error);
  }

  let entry: InstanceType<typeof Entry>;
  try {
    entry = new Entry(KEYRING_SERVICE, baseUrl);
  } catch (error) {
    throw storeError(error);
  }

  return {
    getPassword(): string | null {
      try {
        return entry.getPassword();
      } catch (error) {
        throw storeError(error);
      }
    },
    setPassword(password: string): void {
      try {
        entry.setPassword(password);
      } catch (error) {
        throw storeError(error);
      }
    },
    deletePassword(): boolean {
      try {
        return entry.deleteCredential();
      } catch (error) {
        throw storeError(error);
      }
    },
  };
}

export async function readSecret(streams: Streams): Promise<string> {
  const input = streams.stdin as NodeJS.ReadableStream & {
    isTTY?: boolean;
    setRawMode?: (mode: boolean) => unknown;
  };
  const output = streams.stderr as NodeJS.WritableStream & { isTTY?: boolean };
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== "function") {
    throw new CliError("fs auth set requires an interactive terminal", EXIT.usage, "INTERACTIVE_REQUIRED");
  }

  const muted = new Writable({
    write(_chunk, _encoding, callback): void { callback(); },
  });
  Object.assign(muted, { isTTY: true, columns: 80, rows: 24 });
  streams.stderr.write("Token: ");
  const rl = createInterface({ input, output: muted, terminal: true });
  try {
    return await rl.question("");
  } finally {
    rl.close();
    streams.stderr.write("\n");
  }
}
