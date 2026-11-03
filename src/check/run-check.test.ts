import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browser } from "wxt/browser";
import { fakeBrowser } from "wxt/testing/fake-browser";
import background from "../../entrypoints/background";
import type { ApiResult, Reset, StatusData } from "../api/client";
import {
  CHECK_INTERVAL_MINUTES,
  ENDPOINTS,
  NOTIFICATION_TAGS,
  SITE_ORIGIN,
  STARTUP_CHECK_DELAY_MINUTES,
} from "../config";
import { loadState, updateState } from "../state/store";
import { runMissedAlertCheck } from "./run-check";

const reset: Reset = {
  id: "reset-1",
  reset_type: "regular",
  announced_at: "2026-11-02T10:00:00Z",
  text: "Usage limits reset.",
  source: { type: "x_post", url: "https://example.com/reset-1" },
};
const data: StatusData = {
  latest_reset: reset,
  stats: {
    total: 1,
    last_reset_at: reset.announced_at,
    days_since_last: 0,
    avg_interval_days: null,
  },
};
const at = "2026-11-02T12:00:00.000Z";

function dependencies() {
  return {
    fetchStatus: vi
      .fn<(etag: string | null) => Promise<ApiResult<StatusData>>>()
      .mockResolvedValue({ kind: "ok", data, etag: '"v1"' }),
    loadState,
    updateState,
    showMissedAlert: vi
      .fn<(reset: Reset) => Promise<void>>()
      .mockResolvedValue(undefined),
    resubscribe: vi
      .fn<() => Promise<unknown>>()
      .mockResolvedValue({ ok: true, endpoint: "https://push.example/new" }),
    now: () => new Date(at),
  };
}

beforeEach(async () => {
  fakeBrowser.reset();
  vi.stubGlobal(
    "fetch",
    vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("Unexpected network request")),
  );
  await updateState({
    mode: "on",
    enabledAt: "2026-11-01T00:00:00Z",
    endpoint: "https://push.example/old",
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("runMissedAlertCheck", () => {
  it("skips when alerts are off", async () => {
    await updateState({ mode: "off" });
    const deps = dependencies();
    expect(await runMissedAlertCheck(deps)).toBe("skipped");
    expect(deps.fetchStatus).not.toHaveBeenCalled();
    expect(deps.showMissedAlert).not.toHaveBeenCalled();
    expect((await loadState()).lastCheck).toBeNull();
  });

  it("uses the cached status on 304", async () => {
    await updateState({ statusCache: { etag: '"cached"', data } });
    const deps = dependencies();
    deps.fetchStatus.mockResolvedValue({ kind: "not-modified" });
    expect(await runMissedAlertCheck(deps)).toBe("missed");
    expect(deps.fetchStatus).toHaveBeenCalledExactlyOnceWith('"cached"');
    expect(deps.showMissedAlert).toHaveBeenCalledExactlyOnceWith(reset);
    expect((await loadState()).statusCache).toEqual({ etag: '"cached"', data });
  });

  it("records unavailable for a 304 without cached status", async () => {
    const deps = dependencies();
    deps.fetchStatus.mockResolvedValue({ kind: "not-modified" });
    expect(await runMissedAlertCheck(deps)).toBe("unavailable");
    expect((await loadState()).lastCheck).toMatchObject({
      at,
      outcome: "unavailable",
    });
    expect(deps.showMissedAlert).not.toHaveBeenCalled();
  });

  it.each<ApiResult<StatusData>>([
    { kind: "rate-limited", retryAfterSeconds: 60 },
    { kind: "error", message: "API request failed (HTTP 503)." },
    { kind: "error", message: "Offline" },
  ])(
    "records unavailable on rate limit or error and shows nothing",
    async (result) => {
      const deps = dependencies();
      deps.fetchStatus.mockResolvedValue(result);
      expect(await runMissedAlertCheck(deps)).toBe("unavailable");
      expect((await loadState()).lastCheck).toMatchObject({
        at,
        outcome: "unavailable",
        detail: expect.any(String),
      });
      expect((await loadState()).failure).toBeNull();
      expect(deps.showMissedAlert).not.toHaveBeenCalled();
      expect(deps.resubscribe).not.toHaveBeenCalled();
    },
  );

  it("honors Retry-After across checks", async () => {
    const deps = dependencies();
    deps.fetchStatus.mockResolvedValueOnce({
      kind: "rate-limited",
      retryAfterSeconds: 14_400,
    });
    expect(await runMissedAlertCheck(deps)).toBe("unavailable");
    deps.now = () => new Date("2026-11-02T15:00:00Z");
    expect(await runMissedAlertCheck(deps)).toBe("unavailable");
    expect(deps.fetchStatus).toHaveBeenCalledOnce();
    deps.now = () => new Date("2026-11-02T16:00:00Z");
    expect(await runMissedAlertCheck(deps)).toBe("missed");
    expect(deps.fetchStatus).toHaveBeenCalledTimes(2);
  });

  it("records unavailable when fetching unexpectedly throws", async () => {
    const deps = dependencies();
    deps.fetchStatus.mockRejectedValue(new Error("Offline"));
    expect(await runMissedAlertCheck(deps)).toBe("unavailable");
    expect((await loadState()).lastCheck?.detail).toContain("Offline");
    expect(deps.showMissedAlert).not.toHaveBeenCalled();
  });

  it("notifies, resubscribes and records failure on a miss", async () => {
    const deps = dependencies();
    deps.showMissedAlert.mockImplementation(async () => {
      expect(deps.resubscribe).toHaveBeenCalledOnce();
      expect((await loadState()).failure?.missedResetId).toBe(reset.id);
    });
    expect(await runMissedAlertCheck(deps)).toBe("missed");
    expect(deps.showMissedAlert).toHaveBeenCalledExactlyOnceWith(reset);
    expect(await loadState()).toMatchObject({
      mode: "on",
      enabledAt: "2026-11-01T00:00:00Z",
      endpoint: "https://push.example/new",
      failure: {
        at,
        missedResetId: reset.id,
        reason: expect.stringContaining("push"),
      },
      lastCheck: { at, outcome: "missed" },
      statusCache: { etag: '"v1"', data },
    });
  });

  it("notifies a missed reset only once", async () => {
    const deps = dependencies();
    await runMissedAlertCheck(deps);
    expect(await runMissedAlertCheck(deps)).toBe("missed");
    expect(deps.showMissedAlert).toHaveBeenCalledOnce();
    expect(deps.resubscribe).toHaveBeenCalledOnce();
  });

  it("keeps deduplication after a watch clears failure and the API is unavailable", async () => {
    const deps = dependencies();
    await runMissedAlertCheck(deps);
    await updateState({ failure: null });
    deps.fetchStatus.mockResolvedValueOnce({
      kind: "error",
      message: "Offline",
    });
    expect(await runMissedAlertCheck(deps)).toBe("unavailable");
    await runMissedAlertCheck(deps);
    expect(deps.showMissedAlert).toHaveBeenCalledOnce();
    expect(deps.resubscribe).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    "records a failed resubscription and still notifies: throws=%s",
    async (throws) => {
      const deps = dependencies();
      if (throws)
        deps.resubscribe.mockRejectedValue(new Error("Registration failed"));
      else
        deps.resubscribe.mockResolvedValue({
          ok: false,
          reason: "Registration failed",
        });
      expect(await runMissedAlertCheck(deps)).toBe("missed");
      expect((await loadState()).failure).toMatchObject({
        at,
        missedResetId: reset.id,
        reason: expect.stringContaining("Registration failed"),
      });
      expect((await loadState()).endpoint).toBeNull();
      expect(deps.showMissedAlert).toHaveBeenCalledOnce();
      await runMissedAlertCheck(deps);
      expect(deps.resubscribe).toHaveBeenCalledOnce();
    },
  );

  it("records ok without clearing an existing channel failure", async () => {
    const deps = dependencies();
    await updateState({ failure: { at, reason: "Previous miss" } });
    deps.fetchStatus.mockResolvedValue({
      kind: "ok",
      data: { ...data, latest_reset: null },
      etag: null,
    });
    expect(await runMissedAlertCheck(deps)).toBe("ok");
    expect((await loadState()).lastCheck).toMatchObject({ at, outcome: "ok" });
    expect((await loadState()).failure?.reason).toBe("Previous miss");
    expect((await loadState()).statusCache).toBeNull();
    expect(deps.resubscribe).not.toHaveBeenCalled();
  });

  it("rechecks state after fetching so a delivered push prevents a miss", async () => {
    const deps = dependencies();
    deps.fetchStatus.mockImplementation(async () => {
      await updateState({
        lastResetAlert: { at, url: "https://example.com/" },
      });
      return { kind: "ok", data, etag: null };
    });
    expect(await runMissedAlertCheck(deps)).toBe("ok");
    expect(deps.showMissedAlert).not.toHaveBeenCalled();
  });

  it("skips when alerts were disabled while fetching", async () => {
    const deps = dependencies();
    deps.fetchStatus.mockImplementation(async () => {
      await updateState({ mode: "off" });
      return { kind: "ok", data, etag: null };
    });
    expect(await runMissedAlertCheck(deps)).toBe("skipped");
    expect(deps.resubscribe).not.toHaveBeenCalled();
  });

  it("records notification errors without crashing the check", async () => {
    const deps = dependencies();
    deps.showMissedAlert.mockRejectedValue(new Error("Notification denied"));
    expect(await runMissedAlertCheck(deps)).toBe("missed");
    expect((await loadState()).failure?.reason).toContain(
      "Notification denied",
    );
  });
});

function startBackground() {
  const worker = {
    registration: {
      pushManager: {
        getSubscription: vi.fn(async () => null),
        subscribe: vi.fn(async () => ({
          endpoint: "https://push.example/new",
          toJSON: () => ({ endpoint: "https://push.example/new" }),
          unsubscribe: vi.fn(async () => true),
        })),
      },
      showNotification: vi
        .fn<(title: string, options?: NotificationOptions) => Promise<void>>()
        .mockResolvedValue(undefined),
      getNotifications: vi.fn(async () => []),
    },
    addEventListener: vi.fn(),
  };
  vi.stubGlobal("self", worker);
  const installed = vi.spyOn(browser.runtime.onInstalled, "addListener");
  const startup = vi.spyOn(browser.runtime.onStartup, "addListener");
  const alarm = vi.spyOn(browser.alarms.onAlarm, "addListener");
  const get = vi.spyOn(browser.alarms, "get");
  const create = vi.spyOn(browser.alarms, "create");
  const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (url) => {
    if (url === ENDPOINTS.status)
      return Response.json({ data }, { headers: { ETag: '"v1"' } });
    return Response.json({ ok: true });
  });
  vi.stubGlobal("fetch", fetchMock);
  background.main();
  const fireAlarm = async (name: string) => {
    await alarm.mock.calls[0]![0]({
      name,
      scheduledTime: 0,
      persistAcrossSessions: true,
    });
  };
  return {
    worker,
    installed,
    startup,
    alarm,
    get,
    create,
    fetchMock,
    fireAlarm,
  };
}

describe("missed alert background wiring", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(at));
  });
  afterEach(() => vi.useRealTimers());

  it("creates the periodic check on install", async () => {
    const fixture = startBackground();
    await fixture.installed.mock.calls[0]![0]({ reason: "install" });
    expect(fixture.create).toHaveBeenCalledWith("missed-alert-check", {
      periodInMinutes: CHECK_INTERVAL_MINUTES,
    });
  });

  it.each([false, true])(
    "restores only a missing periodic alarm and delays the startup check: exists=%s",
    async (exists) => {
      const fixture = startBackground();
      fixture.get.mockImplementation(async () =>
        exists
          ? {
              name: "missed-alert-check",
              scheduledTime: 0,
              periodInMinutes: CHECK_INTERVAL_MINUTES,
              persistAcrossSessions: true,
            }
          : undefined,
      );
      await fixture.startup.mock.calls[0]![0]();
      expect(fixture.create).toHaveBeenCalledWith(
        "missed-alert-check-startup",
        { delayInMinutes: STARTUP_CHECK_DELAY_MINUTES },
      );
      expect(fixture.create).toHaveBeenCalledTimes(exists ? 1 : 2);
      expect(fixture.fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each(["missed-alert-check", "missed-alert-check-startup"])(
    "runs %s, renews first and sanitizes the API URL",
    async (name) => {
      const fixture = startBackground();
      fixture.fetchMock.mockImplementation(async (url) => {
        if (url === ENDPOINTS.status)
          return Response.json({
            data: {
              ...data,
              latest_reset: {
                ...reset,
                source: { type: "x_post", url: "javascript:alert(1)" },
              },
            },
          });
        return Response.json({ ok: true });
      });
      await fixture.fireAlarm(name);
      expect(
        fixture.worker.registration.pushManager.subscribe,
      ).toHaveBeenCalledOnce();
      expect(fixture.worker.registration.showNotification).toHaveBeenCalledWith(
        "Push alert missed",
        expect.objectContaining({
          body: expect.stringContaining("Alerts were registered again."),
          tag: NOTIFICATION_TAGS.missed,
          data: { url: `${SITE_ORIGIN}/` },
        }),
      );
      expect(fixture.fetchMock.mock.calls.map(([url]) => url)).toEqual([
        ENDPOINTS.status,
        ENDPOINTS.subscribe,
      ]);
    },
  );

  it("shows a truthful notification when registering again fails", async () => {
    const fixture = startBackground();
    fixture.fetchMock.mockImplementation(async (url) =>
      url === ENDPOINTS.status
        ? Response.json({ data })
        : new Response("down", { status: 503 }),
    );
    await fixture.fireAlarm("missed-alert-check");
    expect(fixture.worker.registration.showNotification).toHaveBeenCalledWith(
      "Push alert missed",
      expect.objectContaining({
        body: expect.stringContaining("Registering alerts again failed."),
        data: { url: reset.source.url },
      }),
    );
    expect(
      fixture.worker.registration.showNotification.mock.calls[0]?.[1],
    ).not.toEqual(
      expect.objectContaining({
        body: expect.stringContaining("Alerts were registered again."),
      }),
    );
    expect((await loadState()).failure?.reason).toContain("503");
  });

  it("does not flag a reset whose push arrived late", async () => {
    const fixture = startBackground();
    await fixture.startup.mock.calls[0]![0]();
    const pushHandler = fixture.worker.addEventListener.mock.calls.find(
      ([name]) => name === "push",
    )![1] as (event: object) => void;
    let pending: Promise<unknown> | undefined;
    pushHandler({
      data: { text: () => JSON.stringify({ kind: "reset" }) },
      waitUntil: (promise: Promise<unknown>) => {
        pending = promise;
      },
    });
    await pending;
    vi.setSystemTime(new Date("2026-11-02T12:05:00Z"));
    await fixture.fireAlarm("missed-alert-check-startup");
    expect(fixture.worker.registration.showNotification).toHaveBeenCalledOnce();
    expect((await loadState()).lastCheck?.outcome).toBe("ok");
    expect(
      fixture.worker.registration.pushManager.subscribe,
    ).not.toHaveBeenCalled();
  });

  it("serializes coincident alarms and ignores unrelated alarms", async () => {
    const fixture = startBackground();
    await fixture.fireAlarm("unrelated");
    expect(fixture.fetchMock).not.toHaveBeenCalled();
    await Promise.all([
      fixture.fireAlarm("missed-alert-check"),
      fixture.fireAlarm("missed-alert-check-startup"),
    ]);
    expect(fixture.worker.registration.showNotification).toHaveBeenCalledOnce();
    expect(
      fixture.worker.registration.pushManager.subscribe,
    ).toHaveBeenCalledOnce();
  });
});
