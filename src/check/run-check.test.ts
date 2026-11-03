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
import { loadState, updateState, type AlertState } from "../state/store";
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
  it("migrates legacy metadata once and keeps retry and deduplication behavior", async () => {
    const checkRetryAfterUntil = Date.parse(at) + 60_000;
    const metadata = {
      missedAlertNotifiedResetId: reset.id,
      checkRetryAfterUntil,
    };
    await browser.storage.local.set({ ...metadata, unrelated: "keep" });
    const remove = vi.spyOn(browser.storage.local, "remove");
    const deps = dependencies();
    expect(await runMissedAlertCheck(deps)).toBe("unavailable");
    expect(await loadState()).toMatchObject(metadata);
    expect(deps.fetchStatus).not.toHaveBeenCalled();
    expect(await browser.storage.local.get(Object.keys(metadata))).toEqual({});
    expect(await browser.storage.local.get("unrelated")).toEqual({
      unrelated: "keep",
    });

    const restarted = dependencies();
    restarted.now = () => new Date(checkRetryAfterUntil);
    expect(await runMissedAlertCheck(restarted)).toBe("missed");
    expect(restarted.fetchStatus).toHaveBeenCalledOnce();
    expect(restarted.showMissedAlert).not.toHaveBeenCalled();
    expect(restarted.resubscribe).not.toHaveBeenCalled();
    expect((await loadState()).checkRetryAfterUntil).toBeNull();
    expect(remove).toHaveBeenCalledExactlyOnceWith(Object.keys(metadata));
  });

  it.each<Record<string, unknown>>([
    { missedAlertNotifiedResetId: reset.id },
    { checkRetryAfterUntil: Date.parse(at) + 60_000 },
  ])("migrates an individual legacy field: %j", async (metadata) => {
    await updateState({ mode: "off" });
    await browser.storage.local.set(metadata);
    const deps = dependencies();
    expect(await runMissedAlertCheck(deps)).toBe("skipped");
    expect(await loadState()).toMatchObject(metadata);
    expect(await browser.storage.local.get(Object.keys(metadata))).toEqual({});
    expect(deps.fetchStatus).not.toHaveBeenCalled();
  });

  it.each<Record<string, unknown>>([
    { missedAlertNotifiedResetId: "" },
    { missedAlertNotifiedResetId: 42 },
    { missedAlertNotifiedResetId: false },
    { missedAlertNotifiedResetId: {} },
    { missedAlertNotifiedResetId: [] },
    { missedAlertNotifiedResetId: null },
    { checkRetryAfterUntil: 0 },
    { checkRetryAfterUntil: -1 },
    { checkRetryAfterUntil: NaN },
    { checkRetryAfterUntil: Infinity },
    { checkRetryAfterUntil: -Infinity },
    { checkRetryAfterUntil: "123" },
    { checkRetryAfterUntil: false },
    { checkRetryAfterUntil: {} },
    { checkRetryAfterUntil: [] },
    { checkRetryAfterUntil: null },
  ])(
    "removes invalid legacy metadata without importing it: %j",
    async (metadata) => {
      const before = await updateState({ mode: "off" });
      await browser.storage.local.set(metadata);
      expect(await runMissedAlertCheck(dependencies())).toBe("skipped");
      expect(await loadState()).toEqual(before);
      expect(await browser.storage.local.get(Object.keys(metadata))).toEqual(
        {},
      );
    },
  );

  it("does not write or remove metadata when legacy keys are absent", async () => {
    const before = await updateState({ mode: "off" });
    const set = vi.spyOn(browser.storage.local, "set");
    const remove = vi.spyOn(browser.storage.local, "remove");
    expect(await runMissedAlertCheck(dependencies())).toBe("skipped");
    expect(await loadState()).toEqual(before);
    expect(set).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it("fills only empty state fields from legacy metadata", async () => {
    await updateState({
      mode: "off",
      missedAlertNotifiedResetId: "newer-reset",
    });
    await browser.storage.local.set({
      missedAlertNotifiedResetId: reset.id,
      checkRetryAfterUntil: Date.parse(at),
    });
    await runMissedAlertCheck(dependencies());
    expect(await loadState()).toMatchObject({
      missedAlertNotifiedResetId: "newer-reset",
      checkRetryAfterUntil: Date.parse(at),
    });
  });

  it("preserves newer state fields and a push queued before migration", async () => {
    await browser.storage.local.set({
      missedAlertNotifiedResetId: reset.id,
      checkRetryAfterUntil: Date.parse(at),
    });
    const newer = {
      mode: "off" as const,
      missedAlertNotifiedResetId: "newer-reset",
      checkRetryAfterUntil: Date.parse(at) + 120_000,
      lastAlert: {
        at,
        kind: "watch" as const,
        title: "Watch",
        url: "https://example.com/reset-1",
      },
      failure: null,
    };
    const deps = dependencies();
    deps.updateState = vi
      .fn(updateState)
      .mockImplementationOnce(async (patch) => {
        await updateState(newer);
        return updateState(patch);
      });
    expect(await runMissedAlertCheck(deps)).toBe("skipped");
    expect(await loadState()).toMatchObject(newer);
    expect(
      await browser.storage.local.get([
        "missedAlertNotifiedResetId",
        "checkRetryAfterUntil",
      ]),
    ).toEqual({});
    expect(deps.fetchStatus).not.toHaveBeenCalled();
  });

  it("keeps legacy metadata if migration cannot persist the state", async () => {
    const metadata = { missedAlertNotifiedResetId: reset.id };
    await browser.storage.local.set(metadata);
    vi.spyOn(browser.storage.local, "set").mockRejectedValueOnce(
      new Error("Storage unavailable"),
    );
    await expect(runMissedAlertCheck(dependencies())).rejects.toThrow(
      "Storage unavailable",
    );
    expect(await browser.storage.local.get(Object.keys(metadata))).toEqual(
      metadata,
    );
    expect((await loadState()).missedAlertNotifiedResetId).toBeNull();
    expect(await runMissedAlertCheck(dependencies())).toBe("missed");
    expect((await loadState()).missedAlertNotifiedResetId).toBe(reset.id);
  });

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

  it("stores retry metadata separately from human check details", async () => {
    const deps = dependencies();
    deps.fetchStatus.mockResolvedValueOnce({
      kind: "rate-limited",
      retryAfterSeconds: 60,
    });
    await runMissedAlertCheck(deps);
    expect((await loadState()).checkRetryAfterUntil).toBe(
      Date.parse(at) + 60_000,
    );
    expect(await browser.storage.local.get("checkRetryAfterUntil")).toEqual({});
    expect((await loadState()).lastCheck?.detail).toBe(
      "The API is rate limited. The check will retry later.",
    );
    await updateState({
      lastCheck: { at, outcome: "ok", detail: "Human text changed." },
    });
    expect(await runMissedAlertCheck(deps)).toBe("unavailable");
    expect(deps.fetchStatus).toHaveBeenCalledOnce();
    deps.now = () => new Date(Date.parse(at) + 60_000);
    await runMissedAlertCheck(deps);
    expect((await loadState()).checkRetryAfterUntil).toBeNull();
  });

  it("caps Retry-After at 24 hours and resumes at the deadline", async () => {
    const deps = dependencies();
    deps.fetchStatus.mockResolvedValueOnce({
      kind: "rate-limited",
      retryAfterSeconds: Number.MAX_SAFE_INTEGER,
    });
    await runMissedAlertCheck(deps);
    deps.now = () => new Date("2026-11-03T11:59:59.999Z");
    expect(await runMissedAlertCheck(deps)).toBe("unavailable");
    expect(deps.fetchStatus).toHaveBeenCalledOnce();
    deps.now = () => new Date("2026-11-03T12:00:00Z");
    expect(await runMissedAlertCheck(deps)).toBe("ok");
    expect(deps.fetchStatus).toHaveBeenCalledTimes(2);
  });

  it("stores the notified reset id independently of check details and channel failure", async () => {
    const deps = dependencies();
    await runMissedAlertCheck(deps);
    expect((await loadState()).missedAlertNotifiedResetId).toBe(reset.id);
    expect(
      await browser.storage.local.get("missedAlertNotifiedResetId"),
    ).toEqual({});
    expect((await loadState()).lastCheck?.detail).toBe(
      "The reset push alert was not received.",
    );
    await updateState({ failure: null, lastCheck: { at, outcome: "ok" } });
    const restarted = dependencies();
    expect(await runMissedAlertCheck(restarted)).toBe("missed");
    expect(restarted.showMissedAlert).not.toHaveBeenCalled();
    expect(restarted.resubscribe).not.toHaveBeenCalled();
    expect((await loadState()).lastCheck?.detail).toBe(
      "This missed reset was already reported.",
    );
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
    const observations: {
      registrations: number;
      failure: AlertState["failure"];
    }[] = [];
    deps.showMissedAlert.mockImplementation(async () => {
      observations.push({
        registrations: deps.resubscribe.mock.calls.length,
        failure: (await loadState()).failure,
      });
    });
    expect(await runMissedAlertCheck(deps)).toBe("missed");
    expect(observations).toEqual([
      {
        registrations: 1,
        failure: expect.objectContaining({ missedResetId: reset.id }),
      },
    ]);
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

async function startBackground() {
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
  await background.main();
  const fireAlarm = async (name: string, scheduledTime = Date.now()) => {
    await alarm.mock.calls[0]![0]({
      name,
      scheduledTime,
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

  it("ensures the periodic alarm on every worker start without duplicating it", async () => {
    const fixture = await startBackground();
    expect(fixture.create).toHaveBeenCalledExactlyOnceWith(
      "missed-alert-check",
      {
        periodInMinutes: CHECK_INTERVAL_MINUTES,
      },
    );
    fixture.create.mockClear();
    await background.main();
    expect(fixture.create).not.toHaveBeenCalled();
    expect(fixture.fetchMock).not.toHaveBeenCalled();
  });

  it("restores a missing periodic alarm when alerts are enabled", async () => {
    const message = vi.spyOn(browser.runtime.onMessage, "addListener");
    const fixture = await startBackground();
    await browser.alarms.clear("missed-alert-check");
    fixture.create.mockClear();
    await updateState({ mode: "off" });
    const response = await new Promise<unknown>((resolve) => {
      message.mock.calls[0]![0]({ type: "enable-alerts" }, {}, resolve);
    });
    expect(response).toMatchObject({ ok: true });
    expect(fixture.create).toHaveBeenCalledExactlyOnceWith(
      "missed-alert-check",
      {
        periodInMinutes: CHECK_INTERVAL_MINUTES,
      },
    );
  });

  it.each(["missed-alert-check", "missed-alert-check-startup"])(
    "defers an overdue %s without fetching or notifying",
    async (name) => {
      const fixture = await startBackground();
      fixture.create.mockClear();
      await fixture.fireAlarm(name, Date.now() - 3 * 3_600_000);
      expect(fixture.fetchMock).not.toHaveBeenCalled();
      expect(
        fixture.worker.registration.showNotification,
      ).not.toHaveBeenCalled();
      expect(fixture.create).toHaveBeenCalledExactlyOnceWith(
        "missed-alert-check-startup",
        {
          delayInMinutes: STARTUP_CHECK_DELAY_MINUTES,
        },
      );
      expect((await loadState()).lastCheck).toBeNull();
    },
  );

  it.each([0, 1])(
    "applies the overdue alarm boundary: extra milliseconds=%s",
    async (extra) => {
      const fixture = await startBackground();
      fixture.create.mockClear();
      await fixture.fireAlarm(
        "missed-alert-check",
        Date.now() - STARTUP_CHECK_DELAY_MINUTES * 60_000 - extra,
      );
      expect(fixture.fetchMock).toHaveBeenCalledTimes(extra ? 0 : 2);
      expect(fixture.create).toHaveBeenCalledTimes(extra ? 1 : 0);
    },
  );

  it.each(["missed-alert-check", "missed-alert-check-startup"])(
    "records an unexpected %s failure and continues handling alarms",
    async (name) => {
      const fixture = await startBackground();
      vi.spyOn(browser.storage.local, "get").mockRejectedValueOnce(
        new Error("Storage read failed"),
      );
      await expect(fixture.fireAlarm(name)).resolves.toBeUndefined();
      expect((await loadState()).lastCheck).toEqual({
        at,
        outcome: "unavailable",
        detail: "Storage read failed",
      });
      expect(fixture.fetchMock).not.toHaveBeenCalled();
      await fixture.fireAlarm(name);
      expect(
        fixture.worker.registration.showNotification,
      ).toHaveBeenCalledOnce();
    },
  );

  it("creates the periodic check on install", async () => {
    const fixture = await startBackground();
    await browser.alarms.clear("missed-alert-check");
    fixture.create.mockClear();
    await fixture.installed.mock.calls[0]![0]({ reason: "install" });
    expect(fixture.create).toHaveBeenCalledWith("missed-alert-check", {
      periodInMinutes: CHECK_INTERVAL_MINUTES,
    });
  });

  it.each([false, true])(
    "restores only a missing periodic alarm and delays the startup check: exists=%s",
    async (exists) => {
      const fixture = await startBackground();
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
      fixture.create.mockClear();
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
      const fixture = await startBackground();
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
    const fixture = await startBackground();
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
    const fixture = await startBackground();
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
    const fixture = await startBackground();
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
