import { AppError } from "./errors";

export interface ByteRange {
  start: number;
  end: number;
}

export function parseRangeHeader(
  value: string | null,
  size: number,
): ByteRange | null {
  if (!value) return null;
  if (size === 0)
    throw new AppError(
      416,
      "range_not_satisfiable",
      "Range cannot be satisfied",
    );

  const match = /^bytes=(\d*)-(\d*)$/u.exec(value.trim());
  if (!match || (!match[1] && !match[2])) {
    throw new AppError(
      416,
      "range_not_satisfiable",
      "Only a single byte range is supported",
    );
  }

  let start: number;
  let end: number;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      throw new AppError(
        416,
        "range_not_satisfiable",
        "Range cannot be satisfied",
      );
    }
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      start >= size ||
      end < start
    ) {
      throw new AppError(
        416,
        "range_not_satisfiable",
        "Range cannot be satisfied",
      );
    }
    end = Math.min(end, size - 1);
  }
  return { start, end };
}
