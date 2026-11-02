import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import {
  DEFAULT_STATE,
  loadState,
  updateState,
  type AlertState,
} from "./store";

const defaults: AlertState = {
  mode: "off",
  enabledAt: null,
  endpoint: null,
  lastAlert: null,
  lastResetAlert: null,
  lastCheck: null,
  failure: null,
  statusCache: null,
};

const enabledAt = "2026-11-01T20:00:00.000Z";
const receivedAt = "2026-11-01T23:28:00.000Z";
const resetUrl = "https://x.com/thsottiaux/status/2117035794678546764";

beforeEach(() => {
  fakeBrowser.reset();
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>().mockRejectedValue(new Error("Unexpected fetch call")),
  );
});

afterEach(() => {
  try {
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

describe("alert state store", () => {
  it("loads defaults when empty", async () => {
    expect(DEFAULT_STATE).toEqual(defaults);
    expect(await loadState()).toEqual(defaults);
    expect(await fakeBrowser.storage.local.get("alertState")).toEqual({});
  });

  it.each([null, "corrupt", ["on"], 42])(
    "loads defaults when the stored value is not an object: %j",
    async (alertState) => {
      await fakeBrowser.storage.local.set({ alertState });
      expect(await loadState()).toEqual(defaults);
    },
  );

  it("merges a partial patch", async () => {
    await fakeBrowser.storage.local.set({
      alertState: { ...defaults, mode: "on", enabledAt },
      unrelated: "keep this value",
    });

    const state = await updateState({ endpoint: "https://push.example/test" });
    const expected = {
      ...defaults,
      mode: "on",
      enabledAt,
      endpoint: "https://push.example/test",
    };
    expect(state).toEqual(expected);
    expect(await loadState()).toEqual(expected);
    expect(await fakeBrowser.storage.local.get(null)).toEqual({
      alertState: expected,
      unrelated: "keep this value",
    });
  });

  it("applies a function patch to the current state", async () => {
    await updateState({ mode: "on", enabledAt });
    await fakeBrowser.storage.local.set({
      alertState: { ...defaults, mode: "on", enabledAt, endpoint: "current" },
    });

    const state = await updateState((current) => ({
      endpoint: `${current.endpoint}/renewed`,
      lastCheck: { at: receivedAt, outcome: "ok" },
    }));
    expect(state).toEqual({
      ...defaults,
      mode: "on",
      enabledAt,
      endpoint: "current/renewed",
      lastCheck: { at: receivedAt, outcome: "ok" },
    });
    expect(await loadState()).toEqual(state);
  });

  it("fills fields missing from an older stored shape with defaults", async () => {
    const olderState = { mode: "on", enabledAt };
    await fakeBrowser.storage.local.set({ alertState: olderState });
    expect(await loadState()).toEqual({ ...defaults, ...olderState });
    expect(await updateState({ mode: "off" })).toEqual({
      ...defaults,
      ...olderState,
      mode: "off",
    });
    expect(
      (await fakeBrowser.storage.local.get("alertState")).alertState,
    ).toEqual({ ...defaults, ...olderState, mode: "off" });
  });

  it("preserves the reset alert, check, failure and cache when a watch arrives", async () => {
    const resetAlert = { at: receivedAt, url: resetUrl };
    const lastCheck = {
      at: receivedAt,
      outcome: "missed" as const,
      detail: "No push",
    };
    const failure = {
      at: receivedAt,
      reason: "Missed alert",
      missedResetId: "2117035794678546764",
    };
    const statusCache = {
      etag: '"status-v1"',
      data: {
        latest_reset: {
          id: "2117035794678546764",
          reset_type: "banked" as const,
          announced_at: "2026-11-01T23:27:20.000Z",
          text: "Day 28/ Banked 2/2",
          source: {
            type: "x_post" as const,
            author: "thsottiaux",
            url: resetUrl,
          },
        },
        stats: {
          total: 71,
          last_reset_at: "2026-11-01T23:27:20.000Z",
          days_since_last: 0.9,
          avg_interval_days: 5.9,
        },
      },
    };
    await updateState({
      mode: "on",
      enabledAt,
      lastAlert: { ...resetAlert, kind: "reset", title: "Confirmed" },
      lastResetAlert: resetAlert,
      lastCheck,
      failure,
      statusCache,
    });
    const lastAlert = {
      at: "2026-11-02T00:00:00.000Z",
      kind: "watch" as const,
      title: "Possible reset",
      url: "https://codex-resets.com/",
    };
    await updateState({ lastAlert });
    expect(await loadState()).toEqual({
      ...defaults,
      mode: "on",
      enabledAt,
      lastAlert,
      lastResetAlert: resetAlert,
      lastCheck,
      failure,
      statusCache,
    });
  });

  it("loads a fresh snapshot instead of sharing the default state", async () => {
    const first = await loadState();
    first.mode = "on";
    expect(await loadState()).toEqual(defaults);
    expect(DEFAULT_STATE).toEqual(defaults);
  });

  it("serializes concurrent updates without losing patches", async () => {
    await Promise.all([
      updateState({ mode: "on", enabledAt }),
      updateState((current) => ({
        lastCheck: {
          at: receivedAt,
          outcome: current.mode === "on" ? "ok" : "unavailable",
        },
      })),
      updateState({ endpoint: "https://push.example/test" }),
    ]);
    expect(await loadState()).toEqual({
      ...defaults,
      mode: "on",
      enabledAt,
      endpoint: "https://push.example/test",
      lastCheck: { at: receivedAt, outcome: "ok" },
    });
  });

  it("surfaces storage errors and allows later updates", async () => {
    const storageError = new Error("Storage unavailable");
    vi.spyOn(fakeBrowser.storage.local, "set").mockRejectedValueOnce(
      storageError,
    );
    await expect(updateState({ mode: "on" })).rejects.toThrow(
      "Storage unavailable",
    );
    expect(await loadState()).toEqual(defaults);
    expect(await updateState({ endpoint: "recovered" })).toEqual({
      ...defaults,
      endpoint: "recovered",
    });
  });

  it.each([
    { mode: "banana", statusCache: "x", lastAlert: [] },
    { mode: null, statusCache: "x", lastAlert: [] },
    { enabledAt: 42, endpoint: false },
    { lastResetAlert: [], lastCheck: "x", failure: [] },
    { statusCache: new Date(), lastAlert: new Date() },
    { unknown: "drop me" },
  ])(
    "rebuilds invalid stored fields from defaults and drops unknown keys: %j",
    async (alertState) => {
      await fakeBrowser.storage.local.set({ alertState });
      expect(await loadState()).toEqual(defaults);
    },
  );

  it.each(["partial", "functional"])(
    "ignores undefined entries in a %s patch",
    async (kind) => {
      const failure = { at: receivedAt, reason: "Missed alert" };
      const original = await updateState({
        mode: "on",
        enabledAt,
        endpoint: "current",
        failure,
      });
      const patch = {
        mode: undefined,
        endpoint: undefined,
        failure: undefined,
      };
      expect(
        await updateState(kind === "partial" ? patch : () => patch),
      ).toEqual(original);
      expect(await loadState()).toEqual(original);
    },
  );

  it("clears a failure with null", async () => {
    await updateState({
      mode: "on",
      enabledAt,
      failure: { at: receivedAt, reason: "Missed alert" },
    });
    expect(await updateState({ failure: null })).toEqual({
      ...defaults,
      mode: "on",
      enabledAt,
    });
    expect(await loadState()).toEqual({ ...defaults, mode: "on", enabledAt });
  });

  it("keeps the exported defaults frozen", () => {
    expect(Reflect.set(DEFAULT_STATE, "mode", "on")).toBe(false);
    expect(DEFAULT_STATE).toEqual(defaults);
  });
});
