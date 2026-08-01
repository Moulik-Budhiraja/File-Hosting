import { AuthRepository } from "../src/server/auth/database";

const username = process.env.FS_BOOTSTRAP_USERNAME;
const password = process.env.FS_BOOTSTRAP_PASSWORD;
const databaseUrl = process.env.DATABASE_URL ?? "file:./data/files.db";

if (!username || !password) {
  throw new Error(
    "FS_BOOTSTRAP_USERNAME and FS_BOOTSTRAP_PASSWORD are required",
  );
}

const repository = await AuthRepository.create(databaseUrl);
try {
  const user = await repository.bootstrapAdmin({ username, password });
  process.stdout.write(`Created initial administrator ${user.username}\n`);
} finally {
  await repository.close();
}
