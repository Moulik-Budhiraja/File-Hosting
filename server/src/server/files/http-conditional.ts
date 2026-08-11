function splitEtags(value: string | null): string[] {
  return (
    value
      ?.split(",")
      .map((entry) => entry.trim())
      .filter(Boolean) ?? []
  );
}

function weakTag(tag: string): string {
  return tag.startsWith("W/") ? tag.slice(2) : tag;
}

export function evaluatePreconditions(
  request: Request,
  etag: string,
  lastModified: Date,
): { status?: 304 | 412; allowRange: boolean } {
  const ifMatch = splitEtags(request.headers.get("if-match"));
  if (
    ifMatch.length > 0 &&
    !ifMatch.includes("*") &&
    !ifMatch.some(
      (candidate) => !candidate.startsWith("W/") && candidate === etag,
    )
  ) {
    return { status: 412, allowRange: false };
  }

  if (!request.headers.has("if-match")) {
    const ifUnmodifiedSince = request.headers.get("if-unmodified-since");
    const since = ifUnmodifiedSince
      ? Date.parse(ifUnmodifiedSince)
      : Number.NaN;
    if (
      Number.isFinite(since) &&
      Math.floor(lastModified.getTime() / 1000) > Math.floor(since / 1000)
    ) {
      return { status: 412, allowRange: false };
    }
  }

  const ifNoneMatch = splitEtags(request.headers.get("if-none-match"));
  if (
    ifNoneMatch.includes("*") ||
    ifNoneMatch.some((candidate) => weakTag(candidate) === weakTag(etag))
  ) {
    return {
      status: request.method === "GET" || request.method === "HEAD" ? 304 : 412,
      allowRange: false,
    };
  }

  if (!request.headers.has("if-none-match")) {
    const ifModifiedSince = request.headers.get("if-modified-since");
    const since = ifModifiedSince ? Date.parse(ifModifiedSince) : Number.NaN;
    if (
      Number.isFinite(since) &&
      Math.floor(lastModified.getTime() / 1000) <= Math.floor(since / 1000)
    ) {
      return { status: 304, allowRange: false };
    }
  }

  const ifRange = request.headers.get("if-range");
  if (!ifRange) return { allowRange: true };
  if (ifRange.startsWith('"') || ifRange.startsWith("W/")) {
    return { allowRange: !ifRange.startsWith("W/") && ifRange === etag };
  }
  const rangeDate = Date.parse(ifRange);
  return {
    allowRange:
      Number.isFinite(rangeDate) &&
      Math.floor(lastModified.getTime() / 1000) <= Math.floor(rangeDate / 1000),
  };
}
