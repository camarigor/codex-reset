import { browser } from "wxt/browser";
import type { StatusData } from "../api/client";

export interface AlertState {
  mode: "off" | "on";
  enabledAt: string | null;
  endpoint: string | null;
  lastAlert: {
    at: string;
    kind: "watch" | "reset";
    title: string;
    url: string;
  } | null;
  lastResetAlert: { at: string; url: string } | null;
  lastCheck: {
    at: string;
    outcome: "ok" | "missed" | "unavailable";
    detail?: string;
  } | null;
  failure: { at: string; reason: string; missedResetId?: string } | null;
  statusCache: { etag: string; data: StatusData } | null;
}

const ALERT_STATE_KEY = "alertState";

export const DEFAULT_STATE: AlertState = Object.freeze({
  mode: "off",
  enabledAt: null,
  endpoint: null,
  lastAlert: null,
  lastResetAlert: null,
  lastCheck: null,
  failure: null,
  statusCache: null,
});

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export async function loadState(): Promise<AlertState> {
  const stored = await browser.storage.local.get(ALERT_STATE_KEY);
  const value = isPlainObject(stored[ALERT_STATE_KEY])
    ? stored[ALERT_STATE_KEY]
    : {};
  return {
    mode:
      value.mode === "on" || value.mode === "off"
        ? value.mode
        : DEFAULT_STATE.mode,
    enabledAt:
      typeof value.enabledAt === "string"
        ? value.enabledAt
        : DEFAULT_STATE.enabledAt,
    endpoint:
      typeof value.endpoint === "string"
        ? value.endpoint
        : DEFAULT_STATE.endpoint,
    lastAlert: isPlainObject(value.lastAlert)
      ? (value.lastAlert as AlertState["lastAlert"])
      : DEFAULT_STATE.lastAlert,
    lastResetAlert: isPlainObject(value.lastResetAlert)
      ? (value.lastResetAlert as AlertState["lastResetAlert"])
      : DEFAULT_STATE.lastResetAlert,
    lastCheck: isPlainObject(value.lastCheck)
      ? (value.lastCheck as AlertState["lastCheck"])
      : DEFAULT_STATE.lastCheck,
    failure: isPlainObject(value.failure)
      ? (value.failure as AlertState["failure"])
      : DEFAULT_STATE.failure,
    statusCache: isPlainObject(value.statusCache)
      ? (value.statusCache as AlertState["statusCache"])
      : DEFAULT_STATE.statusCache,
  };
}

let pendingUpdate: Promise<void> = Promise.resolve();

// This serializes updates only within one JS context; only the background service worker may call it.
export function updateState(
  patch: Partial<AlertState> | ((state: AlertState) => Partial<AlertState>),
): Promise<AlertState> {
  const update = pendingUpdate.then(async () => {
    const current = await loadState();
    const changes = typeof patch === "function" ? patch(current) : patch;
    const definedChanges = Object.fromEntries(
      Object.entries(changes).filter(
        ([key, value]) =>
          Object.hasOwn(DEFAULT_STATE, key) && value !== undefined,
      ),
    );
    const next = { ...current, ...definedChanges };
    await browser.storage.local.set({ [ALERT_STATE_KEY]: next });
    return next;
  });
  pendingUpdate = update.then(
    () => undefined,
    () => undefined,
  );
  return update;
}
