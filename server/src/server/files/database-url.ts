import { mkdir } from "node:fs/promises";
import path from "node:path";

export async function prepareLocalDatabaseDirectory(
  databaseUrl: string,
): Promise<void> {
  if (databaseUrl === ":memory:") {
    throw new Error("Connection-local in-memory databases are not supported");
  }
  if (!databaseUrl.startsWith("file:")) return;
  const raw = databaseUrl.slice("file:".length).split("?")[0];
  if (raw === ":memory:") {
    throw new Error("Connection-local in-memory databases are not supported");
  }
  if (!raw) return;
  const databasePath = path.resolve(decodeURIComponent(raw));
  await mkdir(path.dirname(databasePath), { recursive: true });
}
