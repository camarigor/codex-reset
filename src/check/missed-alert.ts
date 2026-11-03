import type { Reset } from "../api/client";
import {
  MISSED_ALERT_GRACE_MINUTES,
  MISSED_ALERT_WINDOW_HOURS,
} from "../config";

const CLOCK_SKEW_TOLERANCE_MINUTES = 5;

export function findMissedReset(input: {
  latestReset: Reset | null;
  enabledAt: string | null;
  lastResetAlert: { at: string; url: string } | null;
  now: Date;
}): Reset | null {
  const { latestReset: reset, enabledAt, lastResetAlert, now } = input;
  if (!reset || enabledAt === null) return null;

  const announced = Date.parse(reset.announced_at);
  const enabled = Date.parse(enabledAt);
  const checked = now.getTime();
  const received = lastResetAlert ? Date.parse(lastResetAlert.at) : null;
  if (
    ![announced, enabled, checked].every(Number.isFinite) ||
    (received !== null && !Number.isFinite(received))
  )
    return null;

  const age = checked - announced;
  if (
    announced <= enabled + CLOCK_SKEW_TOLERANCE_MINUTES * 60_000 ||
    age < MISSED_ALERT_GRACE_MINUTES * 60_000 ||
    age > MISSED_ALERT_WINDOW_HOURS * 3_600_000
  )
    return null;

  // Provisional matching until a real push payload establishes a stable reset identifier.
  if (
    lastResetAlert &&
    received !== null &&
    received >= enabled &&
    (lastResetAlert.url === reset.source.url ||
      received >= announced - (10 + CLOCK_SKEW_TOLERANCE_MINUTES) * 60_000)
  )
    return null;

  return reset;
}
