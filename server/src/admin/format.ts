const UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // Matches the design's density: KB integers, MB decimals under 100,
  // GB and above always one decimal ("2.0 GB", "412.6 GB").
  const wantsDecimal = unit >= 3 || (unit === 2 && value < 100);
  const rendered = wantsDecimal
    ? value.toFixed(1)
    : Math.round(value).toString();
  return `${rendered} ${UNITS[unit]}`;
}

export function formatExactBytes(bytes: number): string {
  return `${formatInteger(bytes)} bytes · ${formatBytes(bytes)}`;
}

export function formatInteger(value: number): string {
  return value.toLocaleString("en-US");
}

function pad(value: number): string {
  return value.toString().padStart(2, "0");
}

export function formatUtcDateTime(iso: string): string {
  const date = new Date(iso);
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(
    date.getUTCDate(),
  )} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(
    date.getUTCSeconds(),
  )} UTC`;
}

function utcDayNumber(timestamp: number): number {
  return Math.floor(timestamp / 86_400_000);
}

export function formatRecentTimestamp(iso: string, now: number): string {
  const date = new Date(iso);
  const dayDelta = utcDayNumber(now) - utcDayNumber(date.getTime());
  if (dayDelta === 0)
    return `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(
      date.getUTCSeconds(),
    )}`;
  if (dayDelta === 1) return "yesterday";
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`;
}

export function formatListTimestamp(iso: string): string {
  const date = new Date(iso);
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()} ${pad(
    date.getUTCHours(),
  )}:${pad(date.getUTCMinutes())}`;
}

export function formatUptime(totalSeconds: number): string {
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (days > 0 || hours > 0) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);
  return parts.join(" ");
}
