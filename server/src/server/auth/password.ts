import bcrypt from "bcrypt";

import { AppError } from "../files/errors";

export const PASSWORD_COST = 12;
const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,63}$/u;

export function normalizeUsername(value: string): string {
  const normalized = value.trim().toLocaleLowerCase("en-US");
  if (!USERNAME_PATTERN.test(normalized)) {
    throw new AppError(
      400,
      "invalid_username",
      "Username must be 3-64 lowercase letters, numbers, dots, underscores, or hyphens",
    );
  }
  return normalized;
}

export function validatePassword(value: string): string {
  if (value.length < 12 || value.length > 1024) {
    throw new AppError(
      400,
      "invalid_password",
      "Password must be at least 12 characters and no more than 1024 characters",
    );
  }
  return value;
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(validatePassword(password), PASSWORD_COST);
}

export async function verifyPassword(
  password: string,
  encoded: string,
): Promise<boolean> {
  try {
    return await bcrypt.compare(password, encoded);
  } catch {
    return false;
  }
}
