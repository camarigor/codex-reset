import { describe, expect, it } from "vitest";
import type { Reset } from "../api/client";
import { findMissedReset } from "./missed-alert";

const reset: Reset = {
  id: "reset-1",
  reset_type: "regular",
  announced_at: "2026-11-02T10:00:00Z",
  text: "Usage limits reset.",
  source: { type: "x_post", url: "https://example.com/reset-1" },
};

const input = () => ({
  latestReset: reset,
  enabledAt: "2026-11-01T00:00:00Z",
  lastResetAlert: null,
  now: new Date("2026-11-02T12:00:00Z"),
});

describe("findMissedReset", () => {
  it("null without a latest reset", () => {
    expect(findMissedReset({ ...input(), latestReset: null })).toBeNull();
  });

  it("null while alerts were never turned on", () => {
    expect(findMissedReset({ ...input(), enabledAt: null })).toBeNull();
  });

  it("ignores a reset announced before alerts were turned on", () => {
    expect(
      findMissedReset({
        ...input(),
        enabledAt: "2026-11-02T11:00:00Z",
      }),
    ).toBeNull();
  });

  it("ignores a reset announced exactly when alerts were turned on", () => {
    expect(
      findMissedReset({ ...input(), enabledAt: reset.announced_at }),
    ).toBeNull();
  });

  it("ignores a reset older than 24 hours", () => {
    expect(
      findMissedReset({
        ...input(),
        now: new Date("2026-11-03T10:00:00.001Z"),
      }),
    ).toBeNull();
  });

  it("includes the 24 hour boundary", () => {
    expect(
      findMissedReset({
        ...input(),
        now: new Date("2026-11-03T10:00:00Z"),
      }),
    ).toBe(reset);
  });

  it("waits for the 30 minute grace period", () => {
    expect(
      findMissedReset({
        ...input(),
        now: new Date("2026-11-02T10:29:59.999Z"),
      }),
    ).toBeNull();
  });

  it("includes the 30 minute boundary", () => {
    expect(
      findMissedReset({
        ...input(),
        now: new Date("2026-11-02T10:30:00Z"),
      }),
    ).toBe(reset);
  });

  it("ignores future announcements", () => {
    expect(
      findMissedReset({
        ...input(),
        now: new Date("2026-11-02T09:00:00Z"),
      }),
    ).toBeNull();
  });

  it("flags an eligible reset with no reset push", () => {
    expect(findMissedReset(input())).toBe(reset);
  });

  it("does not flag a reset whose push arrived late", () => {
    expect(
      findMissedReset({
        ...input(),
        lastResetAlert: {
          at: "2026-11-02T11:59:00Z",
          url: "https://example.com/",
        },
      }),
    ).toBeNull();
  });

  it("matches a push received exactly 10 minutes before announcement", () => {
    expect(
      findMissedReset({
        ...input(),
        lastResetAlert: {
          at: "2026-11-02T09:50:00Z",
          url: "https://example.com/",
        },
      }),
    ).toBeNull();
  });

  it("does not match an unrelated push older than the matching window", () => {
    expect(
      findMissedReset({
        ...input(),
        lastResetAlert: {
          at: "2026-11-02T09:49:59.999Z",
          url: "https://example.com/",
        },
      }),
    ).toBe(reset);
  });

  it("matches by url when the push url equals source.url", () => {
    expect(
      findMissedReset({
        ...input(),
        lastResetAlert: { at: "2026-11-01T05:00:00Z", url: reset.source.url! },
      }),
    ).toBeNull();
  });

  it("checks observed resets without source URLs", () => {
    const observed: Reset = { ...reset, source: { type: "observed" } };
    expect(findMissedReset({ ...input(), latestReset: observed })).toBe(
      observed,
    );
  });

  it.each(["", "invalid", "2026-99-99T00:00:00Z"])(
    "never flags invalid timestamps: %s",
    (invalid) => {
      expect(findMissedReset({ ...input(), enabledAt: invalid })).toBeNull();
      expect(
        findMissedReset({
          ...input(),
          latestReset: { ...reset, announced_at: invalid },
        }),
      ).toBeNull();
      expect(
        findMissedReset({
          ...input(),
          lastResetAlert: { at: invalid, url: "https://example.com/" },
        }),
      ).toBeNull();
      expect(
        findMissedReset({ ...input(), now: new Date(invalid) }),
      ).toBeNull();
    },
  );
});
