import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import type { ApiResult, Reset, StatusData } from "../api/client";
import { DEFAULT_STATE, type AlertState } from "../state/store";
import {
  buildResetView,
  buildStatusLine,
  combineResults,
  describeToggleFailure,
} from "./popup-model";

interface LocaleMessage {
  message: string;
  placeholders?: Record<string, { content: string }>;
}

const MESSAGES = JSON.parse(
  readFileSync(
    new URL("../../public/_locales/en/messages.json", import.meta.url),
    "utf8",
  ),
) as Record<string, LocaleMessage>;

// Resolves messages like chrome.i18n.getMessage, so tests read the shipped English.
function getMessage(
  name: string,
  substitutions?: string | (string | number)[],
): string {
  const entry = MESSAGES[name];
  if (!entry) return "";
  const values = substitutions === undefined ? [] : [substitutions].flat();
  return entry.message.replace(/\$(\w+)\$/g, (_, placeholder: string) =>
    (entry.placeholders?.[placeholder.toLowerCase()]?.content ?? "").replace(
      /\$([1-9])/g,
      (_match, index: string) => String(values[Number(index) - 1] ?? ""),
    ),
  );
}

beforeEach(() => {
  vi.spyOn(fakeBrowser.i18n, "getMessage").mockImplementation(getMessage);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const NOW = new Date("2026-11-02T12:00:00.000Z");
const FIVE_MINUTES_AGO = "2026-11-02T11:55:00.000Z";
const TWO_HOURS_AGO = "2026-11-02T10:00:00.000Z";
const THREE_HOURS_AGO = "2026-11-02T09:00:00.000Z";
const ONE_DAY_AGO = "2026-11-01T12:00:00.000Z";

function alertsOn(changes: Partial<AlertState> = {}): AlertState {
  return {
    ...DEFAULT_STATE,
    mode: "on",
    enabledAt: FIVE_MINUTES_AGO,
    endpoint: "https://push.example.com/endpoint",
    ...changes,
  };
}

function lastAlert(
  kind: "watch" | "reset",
  at: string,
): AlertState["lastAlert"] {
  return { at, kind, title: "Codex reset", url: "https://codex-resets.com/" };
}

describe("buildStatusLine", () => {
  it("reports that alerts are off", () => {
    expect(buildStatusLine(DEFAULT_STATE, NOW)).toEqual({
      tone: "off",
      text: "Alerts are off.",
    });
  });

  it("reports waiting for the first alert since alerts were turned on", () => {
    expect(buildStatusLine(alertsOn(), NOW)).toEqual({
      tone: "ok",
      text: "Turned on 5 min ago. Waiting for the first alert.",
    });
  });

  it.each([
    ["reset", "Last alert 3 h ago: reset confirmed."],
    ["watch", "Last alert 3 h ago: possible reset."],
  ] as const)("reports the last %s alert with its kind", (kind, text) => {
    const state = alertsOn({
      enabledAt: ONE_DAY_AGO,
      lastAlert: lastAlert(kind, THREE_HOURS_AGO),
    });
    expect(buildStatusLine(state, NOW)).toEqual({ tone: "ok", text });
  });

  it("ignores an alert received before alerts were last turned on", () => {
    const state = alertsOn({ lastAlert: lastAlert("reset", THREE_HOURS_AGO) });
    expect(buildStatusLine(state, NOW).text).toBe(
      "Turned on 5 min ago. Waiting for the first alert.",
    );
  });

  it.each([
    [
      "API request failed (HTTP 503).",
      "Missed-alert check failed 3 h ago: API request failed (HTTP 503).",
    ],
    [
      "Rate limited until 2026-11-02T09:01:00.000Z.",
      "Missed-alert check failed 3 h ago: Rate limited.",
    ],
    [
      'Invalid API response. Missed reset already notified: "r-1"',
      "Missed-alert check failed 3 h ago: Invalid API response.",
    ],
    [undefined, "Missed-alert check failed 3 h ago."],
  ])("reports an unavailable check with the reason %j", (detail, text) => {
    const state = alertsOn({
      enabledAt: ONE_DAY_AGO,
      lastCheck: {
        at: THREE_HOURS_AGO,
        outcome: "unavailable",
        ...(detail === undefined ? {} : { detail }),
      },
    });
    expect(buildStatusLine(state, NOW)).toEqual({ tone: "warning", text });
  });

  it("ignores a check that ran before alerts were last turned on", () => {
    const state = alertsOn({
      lastCheck: { at: THREE_HOURS_AGO, outcome: "unavailable" },
    });
    expect(buildStatusLine(state, NOW).text).toBe(
      "Turned on 5 min ago. Waiting for the first alert.",
    );
  });

  it("reports a missed reset until the next alert arrives", () => {
    const state = alertsOn({
      enabledAt: ONE_DAY_AGO,
      failure: {
        at: TWO_HOURS_AGO,
        reason: "The reset push alert was not received.",
        missedResetId: "r-1",
      },
    });
    expect(buildStatusLine(state, NOW)).toEqual({
      tone: "failing",
      text: "Push did not deliver a reset (detected 2 h ago). This clears when the next alert arrives.",
    });
  });

  it("reports another alert failure with its reason", () => {
    const state = alertsOn({
      enabledAt: ONE_DAY_AGO,
      failure: {
        at: THREE_HOURS_AGO,
        reason: "Push request failed (HTTP 500).",
      },
    });
    expect(buildStatusLine(state, NOW)).toEqual({
      tone: "failing",
      text: "Push alerts are failing (3 h ago): Push request failed (HTTP 500). This clears when the next alert arrives.",
    });
  });

  it("orders the states: off, failure, unavailable check, last alert, waiting", () => {
    const everything = alertsOn({
      enabledAt: ONE_DAY_AGO,
      lastAlert: lastAlert("reset", THREE_HOURS_AGO),
      lastCheck: {
        at: TWO_HOURS_AGO,
        outcome: "unavailable",
        detail: "API request failed (HTTP 503).",
      },
      failure: { at: TWO_HOURS_AGO, reason: "r", missedResetId: "r-1" },
    });

    expect(buildStatusLine({ ...everything, mode: "off" }, NOW)).toEqual({
      tone: "off",
      text: "Alerts are off.",
    });
    expect(buildStatusLine(everything, NOW)).toEqual({
      tone: "failing",
      text: "Push did not deliver a reset (detected 2 h ago). This clears when the next alert arrives.",
    });
    const withoutFailure = { ...everything, failure: null };
    expect(buildStatusLine(withoutFailure, NOW)).toEqual({
      tone: "warning",
      text: "Missed-alert check failed 2 h ago: API request failed (HTTP 503).",
    });
    const withCheckOk: AlertState = {
      ...withoutFailure,
      lastCheck: { at: TWO_HOURS_AGO, outcome: "ok" },
    };
    expect(buildStatusLine(withCheckOk, NOW)).toEqual({
      tone: "ok",
      text: "Last alert 3 h ago: reset confirmed.",
    });
    expect(buildStatusLine({ ...withCheckOk, lastAlert: null }, NOW)).toEqual({
      tone: "ok",
      text: "Turned on 1 day ago. Waiting for the first alert.",
    });
  });
});

const RESET: Reset = {
  id: "r-1",
  reset_type: "banked",
  announced_at: "2026-11-01T23:27:00.000Z",
  text: "Day 28/ Banked 2/2",
  source: {
    type: "x_post",
    author: "thsottiaux",
    url: "https://x.com/thsottiaux/status/1",
  },
};

describe("buildResetView", () => {
  it("removes short links from the text and keeps the announcement link", () => {
    const reset = {
      ...RESET,
      text: "Reset https://t.co/abc confirmed. https://t.co/def",
    };
    const view = buildResetView(reset, NOW, "UTC");
    expect(view.text).toBe("Reset confirmed.");
    expect(view.source).toEqual({ kind: "link", url: RESET.source.url });
    expect(reset.text).toBe("Reset https://t.co/abc confirmed. https://t.co/def");
  });

  it("formats a reset for display", () => {
    const view = buildResetView(RESET, NOW, "UTC");
    expect({ ...view, exactTime: view.exactTime.replace(/\s/g, " ") }).toEqual({
      type: "banked",
      typeLabel: "Banked",
      datetime: "2026-11-01T23:27:00.000Z",
      relativeTime: "12 h ago",
      exactTime: "Nov 1, 2026, 11:27 PM",
      text: "Day 28/ Banked 2/2",
      source: { kind: "link", url: "https://x.com/thsottiaux/status/1" },
    });
  });

  it("formats the exact time in the given time zone", () => {
    expect(
      buildResetView(RESET, NOW, "America/Sao_Paulo").exactTime.replace(
        /\s/g,
        " ",
      ),
    ).toBe("Nov 1, 2026, 8:27 PM");
  });

  it.each([
    [
      { type: "x_post", url: "javascript:alert(1)" },
      { kind: "link", url: "https://codex-resets.com/" },
    ],
    [{ type: "observed" }, { kind: "observed" }],
    [{ type: "x_post" }, { kind: "none" }],
  ] as const)("describes the source %j as %j", (source, expected) => {
    expect(buildResetView({ ...RESET, source }, NOW, "UTC").source).toEqual(
      expected,
    );
  });
});

const STATUS: StatusData = {
  latest_reset: RESET,
  stats: {
    total: 71,
    last_reset_at: RESET.announced_at,
    days_since_last: 0.5,
    avg_interval_days: 5.9,
  },
};

function ok<T>(data: T): ApiResult<T> {
  return { kind: "ok", data, etag: null };
}

describe("combineResults", () => {
  it("is ready when both requests succeed", () => {
    expect(combineResults(ok(STATUS), ok([RESET]))).toEqual({
      kind: "ready",
      status: STATUS,
      resets: [RESET],
    });
  });

  it.each([
    [{ kind: "error", message: "Offline" }, ok([RESET])],
    [ok(STATUS), { kind: "error", message: "Offline" }],
    [{ kind: "not-modified" }, ok([RESET])],
  ] as const)("fails when a request fails: %j, %j", (status, resets) => {
    expect(combineResults(status, resets)).toEqual({ kind: "error" });
  });

  it("reports a rate limit before an error, with the longest wait", () => {
    expect(
      combineResults(
        { kind: "rate-limited", retryAfterSeconds: 30 },
        { kind: "rate-limited", retryAfterSeconds: 90 },
      ),
    ).toEqual({ kind: "rate-limited", retryAfterSeconds: 90 });
    expect(
      combineResults(
        { kind: "error", message: "Offline" },
        { kind: "rate-limited", retryAfterSeconds: 60 },
      ),
    ).toEqual({ kind: "rate-limited", retryAfterSeconds: 60 });
  });
});

describe("describeToggleFailure", () => {
  it.each([
    [
      "Push request failed (HTTP 500).",
      "Could not turn on alerts: Push request failed (HTTP 500).",
    ],
    [
      "Registration failed - permission denied",
      "Could not turn on alerts: Registration failed - permission denied.",
    ],
  ])("explains why turning on failed: %j", (reason, text) => {
    expect(describeToggleFailure("enable-alerts", reason, "off")).toBe(text);
  });

  it("says alerts are off when only the server was not told", () => {
    expect(
      describeToggleFailure(
        "disable-alerts",
        "Push request failed (HTTP 500).",
        "off",
      ),
    ).toBe(
      "Alerts are off. The request asking Codex Resets to remove this browser failed: Push request failed (HTTP 500).",
    );
  });

  it.each(["on", null] as const)(
    "never claims alerts are off when the state is %j",
    (mode) => {
      expect(
        describeToggleFailure("disable-alerts", "Storage is full", mode),
      ).toBe("Storage is full.");
    },
  );
});
