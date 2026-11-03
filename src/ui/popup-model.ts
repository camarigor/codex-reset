// View logic of the popup, kept free of the DOM so it can be tested.

import type { ApiResult, Reset, ResetType, StatusData } from "../api/client";
import type { BackgroundRequest } from "../messages";
import { sanitizeUrl } from "../push/payload";
import type { AlertState } from "../state/store";
import { formatRelativeTime, formatResetType } from "./format";
import { t } from "./i18n";

export type StatusTone = "off" | "ok" | "warning" | "failing";

export interface StatusLine {
  tone: StatusTone;
  text: string;
}

// The missed-alert check stores this marker in lastCheck.detail; it is bookkeeping, not a reason.
const NOTIFIED_MARKER = /\s*Missed reset already notified: "(?:\\.|[^"\\])*"$/;
// The check records a rate limit as "Rate limited until <ISO time>."; the time is noise here.
const RATE_LIMITED = /^(Rate limited) until \S+$/;

/** Drops the final period of a reason that a message follows with its own. */
function withoutFinalPeriod(text: string): string {
  return text.trim().replace(/\.$/, "");
}

/** Ends a reason that closes a message as a sentence. */
function asSentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/**
 * Returns `record` unless it predates the moment alerts were last turned on:
 * turning alerts off and on again keeps lastAlert and lastCheck from earlier
 * sessions, and those say nothing about the current one.
 */
function sinceEnabled<T extends { at: string }>(
  record: T | null,
  enabledAt: string | null,
): T | null {
  if (record === null || enabledAt === null) return record;
  return Date.parse(record.at) < Date.parse(enabledAt) ? null : record;
}

function checkDetail(detail: string | undefined): string {
  return withoutFinalPeriod(
    (detail ?? "").replace(NOTIFIED_MARKER, ""),
  ).replace(RATE_LIMITED, "$1");
}

/**
 * Describes the alert channel with facts, never claiming it is healthy. While
 * alerts are on, the first match wins: a failure, an unavailable missed-alert
 * check, the last alert received, then waiting since alerts were turned on.
 * Alerts that are off override everything, because a failure recorded while
 * turning them on or off clears only when they are on again.
 */
export function buildStatusLine(state: AlertState, now: Date): StatusLine {
  if (state.mode === "off") return { tone: "off", text: t("statusOff") };

  const { failure } = state;
  if (failure !== null) {
    const when = formatRelativeTime(failure.at, now);
    return {
      tone: "failing",
      text:
        failure.missedResetId === undefined
          ? t("statusFailing", [when, withoutFinalPeriod(failure.reason)])
          : t("statusMissedReset", [when]),
    };
  }

  const check = sinceEnabled(state.lastCheck, state.enabledAt);
  if (check?.outcome === "unavailable") {
    const when = formatRelativeTime(check.at, now);
    const detail = checkDetail(check.detail);
    return {
      tone: "warning",
      text: detail
        ? t("statusCheckFailed", [when, detail])
        : t("statusCheckFailedNoDetail", [when]),
    };
  }

  const alert = sinceEnabled(state.lastAlert, state.enabledAt);
  if (alert !== null) {
    const kind = t(
      alert.kind === "reset" ? "alertKindReset" : "alertKindWatch",
    );
    return {
      tone: "ok",
      text: t("statusLastAlert", [formatRelativeTime(alert.at, now), kind]),
    };
  }

  return {
    tone: "ok",
    text: t("statusWaiting", [formatRelativeTime(state.enabledAt ?? "", now)]),
  };
}

export type ResetSourceView =
  { kind: "link"; url: string } | { kind: "observed" } | { kind: "none" };

export interface ResetView {
  type: ResetType;
  typeLabel: "Regular" | "Banked";
  /** The announcement time as the API sent it, for a `<time>` element. */
  datetime: string;
  relativeTime: string;
  exactTime: string;
  text: string;
  source: ResetSourceView;
}

// Dates follow the language of the UI strings, which ship in English only.
const DATE_LOCALE = "en";

/**
 * Prepares a reset from the API for display. Its announcement link goes
 * through sanitizeUrl like every URL from the API. `timeZone` defaults to
 * the system time zone.
 */
export function buildResetView(
  reset: Reset,
  now: Date,
  timeZone?: string,
): ResetView {
  const { source } = reset;
  return {
    type: reset.reset_type,
    typeLabel: formatResetType(reset.reset_type),
    datetime: reset.announced_at,
    relativeTime: formatRelativeTime(reset.announced_at, now),
    exactTime: new Intl.DateTimeFormat(DATE_LOCALE, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone,
    }).format(new Date(reset.announced_at)),
    text: reset.text,
    source:
      source.url !== undefined
        ? { kind: "link", url: sanitizeUrl(source.url) }
        : { kind: source.type === "observed" ? "observed" : "none" },
  };
}

export type PopupData =
  | { kind: "ready"; status: StatusData; resets: Reset[] }
  | { kind: "rate-limited"; retryAfterSeconds: number }
  | { kind: "error" };

/**
 * Combines the two API reads the popup makes. The data shows only when both
 * succeed; a rate limit wins over an error because it says when to retry.
 */
export function combineResults(
  status: ApiResult<StatusData>,
  resets: ApiResult<Reset[]>,
): PopupData {
  if (status.kind === "ok" && resets.kind === "ok") {
    return { kind: "ready", status: status.data, resets: resets.data };
  }
  const waits = [status, resets].flatMap((result) =>
    result.kind === "rate-limited" ? [result.retryAfterSeconds] : [],
  );
  return waits.length > 0
    ? { kind: "rate-limited", retryAfterSeconds: Math.max(...waits) }
    : { kind: "error" };
}

export type ToggleRequest = Exclude<
  BackgroundRequest["type"],
  "get-alert-state"
>;

/**
 * Explains a failed toggle. `mode` is the alert state after the request, or
 * null when the background did not answer; only a state that is off may be
 * described as off.
 */
export function describeToggleFailure(
  request: ToggleRequest,
  reason: string,
  mode: AlertState["mode"] | null,
): string {
  const sentence = asSentence(reason);
  if (request === "enable-alerts") return t("alertsEnableFailed", [sentence]);
  return mode === "off" ? t("alertsDisableNotConfirmed", [sentence]) : sentence;
}
