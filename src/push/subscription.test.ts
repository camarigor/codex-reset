import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { browser } from "wxt/browser";
import background from "../../entrypoints/background";
import { ENDPOINTS, SITE_ORIGIN, SITE_VAPID_PUBLIC_KEY } from "../config";
import { sendToBackground, type BackgroundResponse } from "../messages";
import { DEFAULT_STATE, loadState } from "../state/store";
import {
  disableAlerts,
  enableAlerts,
  resubscribe,
  type PushSubscriptionLike,
} from "./subscription";

const siteKey = Uint8Array.from(
  atob(SITE_VAPID_PUBLIC_KEY.replace(/-/g, "+").replace(/_/g, "/")),
  (character) => character.charCodeAt(0),
).buffer;

function createPush(initialKey?: ArrayBuffer) {
  let current: PushSubscriptionLike | null = null;
  let nextId = 0;
  const subscriptions: PushSubscriptionLike[] = [];
  function makeSubscription(key: ArrayBuffer): PushSubscriptionLike {
    const endpoint = `https://push.example/${++nextId}`;
    const subscription: PushSubscriptionLike = {
      endpoint,
      options: { applicationServerKey: key },
      toJSON: () => ({ endpoint, keys: { p256dh: "public", auth: "secret" } }),
      unsubscribe: vi.fn(async () => {
        if (current === subscription) current = null;
        return true;
      }),
    };
    subscriptions.push(subscription);
    return subscription;
  }
  if (initialKey) current = makeSubscription(initialKey);
  const push = {
    getSubscription: vi.fn(async () => current),
    subscribe: vi.fn(async (options: PushSubscriptionOptionsInit) => {
      expect(options.userVisibleOnly).toBe(true);
      expect(
        new Uint8Array(options.applicationServerKey as ArrayBuffer),
      ).toEqual(new Uint8Array(siteKey));
      current = makeSubscription(siteKey);
      return current;
    }),
  };
  return { push, subscriptions, current: () => current };
}

function createFetch() {
  return vi
    .fn<typeof fetch>()
    .mockImplementation(async () => Response.json({ ok: true }));
}

beforeEach(() => {
  fakeBrowser.reset();
  vi.stubGlobal(
    "fetch",
    vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("Unexpected network request")),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("subscription lifecycle", () => {
  it("subscribes with a 65-byte uncompressed site key", async () => {
    const { push } = createPush();
    await enableAlerts(push, createFetch());
    const key = push.subscribe.mock.calls[0]![0].applicationServerKey;
    const bytes = new Uint8Array(key as ArrayBuffer);
    expect(bytes).toHaveLength(65);
    expect(bytes[0]).toBe(4);
  });

  it("reports subscribe rejection without contacting the server and allows retry", async () => {
    const { push, current } = createPush();
    push.subscribe.mockRejectedValueOnce(new Error("Permission denied"));
    const fetchFn = createFetch();
    expect(await enableAlerts(push, fetchFn)).toEqual({
      ok: false,
      reason: "Permission denied",
    });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(current()).toBeNull();
    expect((await enableAlerts(push, fetchFn)).ok).toBe(true);
  });

  it("replaces locally removed subscriptions even if server unregistration fails", async () => {
    const { push, current } = createPush(new Uint8Array([1]).buffer);
    const old = current()!;
    const fetchFn = createFetch().mockRejectedValueOnce(new Error("Offline"));
    expect(await enableAlerts(push, fetchFn)).toEqual({
      ok: true,
      endpoint: "https://push.example/2",
    });
    expect(old.unsubscribe).toHaveBeenCalledOnce();
    expect(current()!.endpoint).toBe("https://push.example/2");
    expect(fetchFn.mock.calls.map(([url]) => url)).toEqual([
      ENDPOINTS.unsubscribe,
      ENDPOINTS.subscribe,
    ]);
  });

  it.each([false, true])(
    "checks a live subscription after unsubscribe returns false: %s",
    async (stillLive) => {
      const { push, current } = createPush(siteKey);
      const old = current()!;
      const unsubscribe = vi.mocked(old.unsubscribe).getMockImplementation()!;
      vi.mocked(old.unsubscribe).mockImplementationOnce(async () => {
        if (!stillLive) await unsubscribe();
        return false;
      });
      const result = await disableAlerts(push, createFetch());
      expect(result).toEqual(
        stillLive
          ? {
              serverNotified: true,
              reason: "The browser did not remove the push subscription.",
            }
          : { serverNotified: true },
      );
      expect(push.getSubscription).toHaveBeenCalledTimes(2);
      expect(current()).toBe(stillLive ? old : null);
    },
  );

  it("reuses a subscription made with the site key", async () => {
    const { push, current } = createPush(siteKey);
    const subscription = current()!;
    const result = await enableAlerts(push, createFetch());
    expect(result).toEqual({ ok: true, endpoint: subscription.endpoint });
    expect(push.subscribe).not.toHaveBeenCalled();
    expect(subscription.unsubscribe).not.toHaveBeenCalled();
  });

  it("replaces a subscription made with another key", async () => {
    const { push, current } = createPush(new Uint8Array([1, 2]).buffer);
    const old = current()!;
    const fetchFn = createFetch();
    expect(await enableAlerts(push, fetchFn)).toEqual({
      ok: true,
      endpoint: "https://push.example/2",
    });
    expect(old.unsubscribe).toHaveBeenCalledOnce();
    expect(push.subscribe).toHaveBeenCalledOnce();
    expect(fetchFn).toHaveBeenCalledWith(
      ENDPOINTS.unsubscribe,
      expect.objectContaining({
        body: JSON.stringify({ endpoint: old.endpoint }),
      }),
    );
  });

  it("posts subscription.toJSON() to the subscribe endpoint", async () => {
    const { push, current } = createPush();
    const fetchFn = createFetch();
    await enableAlerts(push, fetchFn);
    expect(fetchFn).toHaveBeenCalledExactlyOnceWith(ENDPOINTS.subscribe, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(current()!.toJSON()),
      signal: expect.any(AbortSignal),
    });
  });

  it("unsubscribes locally when the server rejects", async () => {
    const { push, current, subscriptions } = createPush();
    const fetchFn = createFetch().mockResolvedValue(
      new Response("down", { status: 503 }),
    );
    expect((await enableAlerts(push, fetchFn)).ok).toBe(false);
    expect(subscriptions[0]!.unsubscribe).toHaveBeenCalledOnce();
    expect(current()).toBeNull();
  });

  it.each(["body", "invalid-json", "network"])(
    "unsubscribes locally when the server rejects: %s",
    async (failure) => {
      const { push, current, subscriptions } = createPush();
      const fetchFn = createFetch();
      if (failure === "body")
        fetchFn.mockResolvedValue(Response.json({ ok: false }));
      if (failure === "invalid-json")
        fetchFn.mockResolvedValue(new Response("invalid"));
      if (failure === "network")
        fetchFn.mockRejectedValue(new Error("Offline"));
      const result = await enableAlerts(push, fetchFn);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBeTruthy();
      expect(subscriptions[0]!.unsubscribe).toHaveBeenCalledOnce();
      expect(current()).toBeNull();
    },
  );

  it("disable posts the endpoint to the unsubscribe endpoint and still unsubscribes when the server fails", async () => {
    const { push, current } = createPush(siteKey);
    const old = current()!;
    const fetchFn = createFetch().mockImplementation(async () => {
      expect(current()).toBeNull();
      return new Response("down", { status: 503 });
    });
    const result = await disableAlerts(push, fetchFn);
    expect(result.serverNotified).toBe(false);
    expect(result.reason).toContain("503");
    expect(old.unsubscribe).toHaveBeenCalledOnce();
    expect(fetchFn).toHaveBeenCalledWith(
      ENDPOINTS.unsubscribe,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ endpoint: old.endpoint }),
      }),
    );
  });

  it("disables without a subscription or network request", async () => {
    const { push } = createPush();
    const fetchFn = createFetch();
    expect(await disableAlerts(push, fetchFn)).toEqual({
      serverNotified: true,
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("resubscribe tells the server to drop the old endpoint", async () => {
    const { push, current } = createPush(siteKey);
    const old = current()!;
    const fetchFn = createFetch();
    expect(await resubscribe(push, fetchFn)).toEqual({
      ok: true,
      endpoint: "https://push.example/2",
    });
    expect(old.unsubscribe).toHaveBeenCalledOnce();
    expect(fetchFn.mock.calls.map(([url]) => url)).toEqual([
      ENDPOINTS.unsubscribe,
      ENDPOINTS.subscribe,
    ]);
    expect(fetchFn.mock.calls[0]![1]?.body).toBe(
      JSON.stringify({ endpoint: old.endpoint }),
    );
  });

  it("serializes concurrent enable and disable", async () => {
    const { push, current, subscriptions } = createPush();
    const fetchFn = createFetch();
    const results = await Promise.all([
      enableAlerts(push, fetchFn),
      disableAlerts(push, fetchFn),
      enableAlerts(push, fetchFn),
    ]);
    expect(results).toEqual([
      { ok: true, endpoint: "https://push.example/1" },
      { serverNotified: true },
      { ok: true, endpoint: "https://push.example/2" },
    ]);
    expect(subscriptions).toHaveLength(2);
    expect(subscriptions[0]!.unsubscribe).toHaveBeenCalledOnce();
    expect(subscriptions[1]!.unsubscribe).not.toHaveBeenCalled();
    expect(current()).toBe(subscriptions[1]);
    expect(fetchFn.mock.calls.map(([url]) => url)).toEqual([
      ENDPOINTS.subscribe,
      ENDPOINTS.unsubscribe,
      ENDPOINTS.subscribe,
    ]);
  });

  it("continues the queue after a browser failure", async () => {
    const { push } = createPush();
    push.getSubscription.mockRejectedValueOnce(new Error("Push unavailable"));
    expect(await enableAlerts(push, createFetch())).toEqual({
      ok: false,
      reason: "Push unavailable",
    });
    expect((await enableAlerts(push, createFetch())).ok).toBe(true);
  });

  it("does not create another subscription when local removal fails", async () => {
    const { push, current } = createPush(new Uint8Array([1]).buffer);
    vi.mocked(current()!.unsubscribe).mockResolvedValue(false);
    expect((await enableAlerts(push, createFetch())).ok).toBe(false);
    expect(push.subscribe).not.toHaveBeenCalled();
  });
});

function startBackground() {
  const fixture = createPush();
  const worker = {
    registration: {
      pushManager: fixture.push,
      showNotification: vi.fn(async () => {}),
      getNotifications: vi.fn(async () => []),
    },
    addEventListener: vi.fn(),
  };
  vi.stubGlobal("self", worker);
  vi.stubGlobal("fetch", createFetch());
  const messageListener = vi.spyOn(browser.runtime.onMessage, "addListener");
  background.main();
  const listener = messageListener.mock.calls[0]![0];
  const request = (type: string) =>
    new Promise<BackgroundResponse>((resolve) => {
      expect(listener({ type }, {}, resolve)).toBe(true);
    });
  async function dispatch(type: string, event: object) {
    let pending: Promise<unknown> | undefined;
    const waitUntil = (promise: Promise<unknown>) => {
      pending = promise;
    };
    const handler = worker.addEventListener.mock.calls.find(
      ([name]) => name === type,
    )![1] as (event: object) => void;
    handler({ ...event, waitUntil });
    expect(pending).toBeDefined();
    await pending;
  }
  return { ...fixture, worker, request, dispatch, messageListener };
}

describe("background wiring", () => {
  it.each(["enable-alerts", "disable-alerts"])(
    "clears stored failure after successful %s",
    async (type) => {
      const { request } = startBackground();
      await request("enable-alerts");
      await fakeBrowser.storage.local.set({
        alertState: {
          ...(await loadState()),
          failure: { at: "old", reason: "Offline" },
        },
      });
      const response = await request(type);
      expect(response.ok).toBe(true);
      expect(response.state.failure).toBeNull();
      expect(response.state.mode).toBe(type === "enable-alerts" ? "on" : "off");
    },
  );

  it("continues lifecycle and push handling after a storage rejection", async () => {
    const { request, dispatch, worker } = startBackground();
    vi.spyOn(fakeBrowser.storage.local, "set").mockRejectedValueOnce(
      new Error("Storage unavailable"),
    );
    expect(await request("enable-alerts")).toMatchObject({
      ok: false,
      error: "Storage unavailable",
    });
    expect((await request("get-alert-state")).ok).toBe(true);
    expect((await request("disable-alerts")).ok).toBe(true);
    await dispatch("push", { data: null });
    expect(worker.registration.showNotification).toHaveBeenCalledOnce();
    expect((await loadState()).lastAlert?.kind).toBe("reset");
  });

  it("continues lifecycle and push handling after a notification rejection", async () => {
    const { request, dispatch, worker } = startBackground();
    worker.registration.showNotification.mockRejectedValueOnce(
      new Error("Notification unavailable"),
    );
    await expect(dispatch("push", { data: null })).rejects.toThrow(
      "Notification unavailable",
    );
    expect((await loadState()).lastAlert).toBeNull();
    expect((await request("get-alert-state")).ok).toBe(true);
    expect((await request("enable-alerts")).ok).toBe(true);
    await dispatch("push", { data: null });
    expect(worker.registration.showNotification).toHaveBeenCalledTimes(2);
    expect((await loadState()).lastAlert?.kind).toBe("reset");
  });

  it.each([
    { message: { type: "unknown" }, sender: {} },
    { message: null, sender: {} },
    { message: "disable-alerts", sender: {} },
    {
      message: { type: "disable-alerts" },
      sender: { id: "foreign-extension" },
    },
  ])("ignores untrusted messages: $message", async ({ message, sender }) => {
    const { request, messageListener, push, worker } = startBackground();
    await request("enable-alerts");
    const state = await loadState();
    const set = vi.spyOn(fakeBrowser.storage.local, "set");
    const sendResponse = vi.fn();
    const listener = messageListener.mock.calls[0]![0];
    expect(listener(message, sender, sendResponse)).toBeUndefined();
    await request("get-alert-state");
    expect(sendResponse).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
    expect(push.subscribe).toHaveBeenCalledOnce();
    expect(vi.mocked(fetch)).toHaveBeenCalledOnce();
    expect(worker.registration.showNotification).not.toHaveBeenCalled();
    expect(await loadState()).toEqual(state);
  });

  it("reads state while a lifecycle request is waiting for the server", async () => {
    const { request } = startBackground();
    const gate = Promise.withResolvers<Response>();
    vi.mocked(fetch).mockReturnValueOnce(gate.promise);
    const enable = request("enable-alerts");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    let response: BackgroundResponse | undefined;
    const read = request("get-alert-state").then((value) => {
      response = value;
    });
    try {
      await vi.waitFor(
        () => expect(response).toEqual({ ok: true, state: DEFAULT_STATE }),
        { timeout: 1000 },
      );
    } finally {
      gate.resolve(Response.json({ ok: true }));
      await Promise.all([enable, read]);
    }
  });

  it("shows and records push while a lifecycle request is waiting for the server", async () => {
    const { request, dispatch, worker } = startBackground();
    const gate = Promise.withResolvers<Response>();
    vi.mocked(fetch).mockReturnValueOnce(gate.promise);
    const enable = request("enable-alerts");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const push = dispatch("push", { data: null });
    try {
      await vi.waitFor(
        () =>
          expect(worker.registration.showNotification).toHaveBeenCalledOnce(),
        { timeout: 1000 },
      );
      await push;
      expect((await loadState()).lastAlert?.kind).toBe("reset");
    } finally {
      gate.resolve(Response.json({ ok: true }));
      await Promise.all([enable, push]);
    }
  });

  it("settles push after showing it when recording fails", async () => {
    const { dispatch, worker } = startBackground();
    vi.spyOn(fakeBrowser.storage.local, "set").mockRejectedValueOnce(
      new Error("Storage unavailable"),
    );
    await expect(dispatch("push", { data: null })).resolves.toBeUndefined();
    expect(worker.registration.showNotification).toHaveBeenCalledOnce();
    expect((await loadState()).lastAlert).toBeNull();
    await dispatch("push", { data: null });
    expect((await loadState()).lastAlert?.kind).toBe("reset");
  });

  it.each(["enable-alerts", "disable-alerts", "get-alert-state"])(
    "responds with defaults when both the request and recovery reads fail: %s",
    async (type) => {
      const { request } = startBackground();
      vi.spyOn(fakeBrowser.storage.local, "get").mockRejectedValue(
        new Error("Storage unavailable"),
      );
      expect(await request(type)).toEqual({
        ok: false,
        error: "Storage unavailable",
        state: DEFAULT_STATE,
      });
    },
  );

  it("registers all listeners synchronously and reads the default state", async () => {
    const { worker, messageListener, request } = startBackground();
    expect(worker.addEventListener.mock.calls.map(([name]) => name)).toEqual([
      "push",
      "notificationclick",
      "pushsubscriptionchange",
    ]);
    expect(messageListener).toHaveBeenCalledOnce();
    expect(await request("get-alert-state")).toEqual({
      ok: true,
      state: await loadState(),
    });
  });

  it("keeps state consistent for concurrent on, off, on messages", async () => {
    const { request, current } = startBackground();
    const responses = await Promise.all([
      request("enable-alerts"),
      request("disable-alerts"),
      request("enable-alerts"),
    ]);
    expect(responses.map((response) => response.state.mode)).toEqual([
      "on",
      "off",
      "on",
    ]);
    expect(await loadState()).toMatchObject({
      mode: "on",
      endpoint: current()!.endpoint,
      failure: null,
    });
    expect(responses[2]!.state.enabledAt).toEqual(expect.any(String));
  });

  it("records registration failure and stays off", async () => {
    const { request } = startBackground();
    vi.mocked(fetch).mockRejectedValue(new Error("Offline"));
    expect(await request("enable-alerts")).toMatchObject({
      ok: false,
      error: "Offline",
      state: {
        mode: "off",
        enabledAt: null,
        endpoint: null,
        failure: { reason: "Offline" },
      },
    });
  });

  it("turns off even if server unregistration fails", async () => {
    const { request, current } = startBackground();
    await request("enable-alerts");
    vi.mocked(fetch).mockRejectedValue(new Error("Offline"));
    expect(await request("disable-alerts")).toMatchObject({
      ok: false,
      state: {
        mode: "off",
        enabledAt: null,
        endpoint: null,
        failure: { reason: "Offline" },
      },
    });
    expect(current()).toBeNull();
  });

  it("shows push before recording it and clears failure", async () => {
    const { worker, dispatch } = startBackground();
    await fakeBrowser.storage.local.set({
      alertState: { failure: { at: "old", reason: "Offline" } },
    });
    worker.registration.showNotification.mockImplementationOnce(async () => {
      expect((await loadState()).lastAlert).toBeNull();
    });
    await dispatch("push", {
      data: {
        text: () =>
          JSON.stringify({ kind: "reset", url: "javascript:alert(1)" }),
      },
    });
    expect(worker.registration.showNotification).toHaveBeenCalledOnce();
    expect(await loadState()).toMatchObject({
      lastAlert: { kind: "reset", url: `${SITE_ORIGIN}/` },
      lastResetAlert: { url: `${SITE_ORIGIN}/` },
      failure: null,
    });
    const reset = (await loadState()).lastResetAlert;
    await dispatch("push", { data: { text: () => '{"kind":"watch"}' } });
    expect((await loadState()).lastResetAlert).toEqual(reset);
  });

  it("closes clicked notifications and sanitizes their urls", async () => {
    const { dispatch } = startBackground();
    const create = vi.spyOn(browser.tabs, "create");
    const close = vi.fn();
    await dispatch("notificationclick", {
      notification: { close, data: { url: "javascript:alert(1)" } },
    });
    expect(close).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith({ url: `${SITE_ORIGIN}/` });
  });

  it("renews a changed subscription only while on", async () => {
    const { dispatch, request, push, current } = startBackground();
    await dispatch("pushsubscriptionchange", {});
    expect(push.subscribe).not.toHaveBeenCalled();
    await request("enable-alerts");
    const enabledAt = (await loadState()).enabledAt;
    await dispatch("pushsubscriptionchange", {});
    expect(await loadState()).toMatchObject({
      endpoint: current()!.endpoint,
      enabledAt,
    });
    expect(push.subscribe).toHaveBeenCalledTimes(2);
  });

  it("records a failed subscription change without resetting enabledAt", async () => {
    const { dispatch, request } = startBackground();
    await request("enable-alerts");
    const enabledAt = (await loadState()).enabledAt;
    vi.mocked(fetch).mockRejectedValue(new Error("Offline"));
    await dispatch("pushsubscriptionchange", {});
    expect(await loadState()).toMatchObject({
      mode: "on",
      enabledAt,
      endpoint: null,
      failure: { reason: "Offline" },
    });
  });

  it("does not renew after a concurrent disable request", async () => {
    const { dispatch, request, push, current } = startBackground();
    await request("enable-alerts");
    await Promise.all([
      request("disable-alerts"),
      dispatch("pushsubscriptionchange", {}),
    ]);
    expect(current()).toBeNull();
    expect(push.subscribe).toHaveBeenCalledOnce();
    expect(await loadState()).toMatchObject({ mode: "off", endpoint: null });
  });

  it("keeps the original enabledAt when already on", async () => {
    const { request } = startBackground();
    await request("enable-alerts");
    const enabledAt = (await loadState()).enabledAt;
    await request("enable-alerts");
    expect((await loadState()).enabledAt).toBe(enabledAt);
  });

  it("sendToBackground forwards requests", async () => {
    const response: BackgroundResponse = { ok: true, state: await loadState() };
    const send = vi
      .spyOn(browser.runtime, "sendMessage")
      .mockImplementation(() => Promise.resolve(response));
    expect(await sendToBackground({ type: "get-alert-state" })).toEqual(
      response,
    );
    expect(send).toHaveBeenCalledWith({ type: "get-alert-state" });
  });
});
