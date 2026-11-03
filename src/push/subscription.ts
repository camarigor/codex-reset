import { ENDPOINTS, SITE_VAPID_PUBLIC_KEY } from "../config";

export interface PushHost {
  getSubscription(): Promise<PushSubscriptionLike | null>;
  subscribe(
    options: PushSubscriptionOptionsInit,
  ): Promise<PushSubscriptionLike>;
}

export interface PushSubscriptionLike {
  endpoint: string;
  options: { applicationServerKey: ArrayBuffer | null };
  toJSON(): PushSubscriptionJSON;
  unsubscribe(): Promise<boolean>;
}

type EnableResult =
  { ok: true; endpoint: string } | { ok: false; reason: string };
type DisableResult = { serverNotified: boolean; reason?: string };

let pending: Promise<void> = Promise.resolve();

function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const result = pending.then(operation);
  pending = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function reason(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : "Unable to update push subscription.";
}

function applicationServerKey(): Uint8Array<ArrayBuffer> {
  const encoded = SITE_VAPID_PUBLIC_KEY.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
}

function usesSiteKey(subscription: PushSubscriptionLike): boolean {
  const key = subscription.options.applicationServerKey;
  if (key === null) return false;
  const actual = new Uint8Array(key);
  const expected = applicationServerKey();
  return (
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

async function post(
  url: string,
  body: unknown,
  fetchFn: typeof fetch,
): Promise<void> {
  const response = await fetchFn(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok)
    throw new Error(`Push request failed (HTTP ${response.status}).`);
  const data: unknown = await response.json();
  if (
    typeof data !== "object" ||
    data === null ||
    !("ok" in data) ||
    data.ok !== true
  ) {
    throw new Error("The server did not confirm the push request.");
  }
}

async function remove(
  push: PushHost,
  subscription: PushSubscriptionLike,
  fetchFn: typeof fetch,
): Promise<DisableResult> {
  let localFailure: string | undefined;
  try {
    if (!(await subscription.unsubscribe()) && (await push.getSubscription())) {
      localFailure = "The browser did not remove the push subscription.";
    }
  } catch (error) {
    localFailure = reason(error);
  }

  let serverFailure: string | undefined;
  try {
    await post(
      ENDPOINTS.unsubscribe,
      { endpoint: subscription.endpoint },
      fetchFn,
    );
  } catch (error) {
    serverFailure = reason(error);
  }
  const failure = [localFailure, serverFailure].filter(Boolean).join(" ");
  return {
    serverNotified: serverFailure === undefined,
    ...(failure ? { reason: failure } : {}),
  };
}

async function register(
  push: PushHost,
  fetchFn: typeof fetch,
  replace: boolean,
): Promise<EnableResult> {
  try {
    let subscription = await push.getSubscription();
    if (subscription && (replace || !usesSiteKey(subscription))) {
      const removed = await remove(push, subscription, fetchFn);
      // A server failure is recoverable, but a live local subscription must not be replaced.
      if (await push.getSubscription()) {
        return {
          ok: false,
          reason:
            removed.reason ??
            "The browser did not remove the push subscription.",
        };
      }
      subscription = null;
    }
    subscription ??= await push.subscribe({
      userVisibleOnly: true,
      applicationServerKey: applicationServerKey(),
    });
    try {
      await post(ENDPOINTS.subscribe, subscription.toJSON(), fetchFn);
    } catch (error) {
      let failure = reason(error);
      try {
        if (!(await subscription.unsubscribe())) {
          failure += " The browser did not remove the push subscription.";
        }
      } catch (cleanupError) {
        failure += ` ${reason(cleanupError)}`;
      }
      return { ok: false, reason: failure };
    }
    return { ok: true, endpoint: subscription.endpoint };
  } catch (error) {
    return { ok: false, reason: reason(error) };
  }
}

export function enableAlerts(
  push: PushHost,
  fetchFn: typeof fetch = fetch,
): Promise<EnableResult> {
  return serialize(() => register(push, fetchFn, false));
}

export function disableAlerts(
  push: PushHost,
  fetchFn: typeof fetch = fetch,
): Promise<DisableResult> {
  return serialize(async () => {
    try {
      const subscription = await push.getSubscription();
      return subscription
        ? await remove(push, subscription, fetchFn)
        : { serverNotified: true };
    } catch (error) {
      return { serverNotified: false, reason: reason(error) };
    }
  });
}

export function resubscribe(
  push: PushHost,
  fetchFn: typeof fetch = fetch,
): Promise<EnableResult> {
  return serialize(() => register(push, fetchFn, true));
}
