// Display formatters for reset data. Their output is English and lives here
// rather than in messages.json because chrome.i18n has no plural rules:
// localizing them means one message per plural form of each unit.

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * Formats how long ago `iso` happened, relative to `now`: "just now",
 * "5 min ago", "3 h ago", "1 day ago", "2 days ago". Each unit rounds down.
 * A timestamp in the future (clock skew) renders "just now"; an unparsable
 * timestamp or an invalid `now` renders "n/a".
 */
export function formatRelativeTime(iso: string, now: Date): string {
  const elapsed = now.getTime() - Date.parse(iso);
  if (Number.isNaN(elapsed)) return "n/a";
  if (elapsed < MINUTE_MS) return "just now";
  if (elapsed < HOUR_MS) return `${Math.floor(elapsed / MINUTE_MS)} min ago`;
  if (elapsed < DAY_MS) return `${Math.floor(elapsed / HOUR_MS)} h ago`;
  const days = Math.floor(elapsed / DAY_MS);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

const RESET_TYPE_LABELS = {
  regular: "Regular",
  banked: "Banked",
} as const;

/** Labels a reset type from the Codex Resets API for display. */
export function formatResetType(
  type: "regular" | "banked",
): "Regular" | "Banked" {
  return RESET_TYPE_LABELS[type];
}

/**
 * Formats a day count from the API with one decimal, as the site shows it:
 * "5.9 days". A missing, non-finite or negative value renders "n/a".
 */
export function formatDays(value: number | null): string {
  if (value === null || !Number.isFinite(value) || value < 0) return "n/a";
  return `${value.toFixed(1)} days`;
}
