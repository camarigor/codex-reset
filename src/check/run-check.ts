import { browser } from "wxt/browser";
import type { fetchStatus, Reset } from "../api/client";
import type { loadState, updateState } from "../state/store";
import { findMissedReset } from "./missed-alert";

function message(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : "Unable to complete the missed-alert check.";
}

const NOTIFIED_RESET_KEY = "missedAlertNotifiedResetId";
const RETRY_AFTER_KEY = "checkRetryAfterUntil";
const MAX_RETRY_AFTER_SECONDS = 24 * 60 * 60;

export async function runMissedAlertCheck(deps: {
  fetchStatus: typeof fetchStatus;
  loadState: typeof loadState;
  updateState: typeof updateState;
  showMissedAlert: (reset: Reset) => Promise<void>;
  resubscribe: () => Promise<unknown>;
  now: () => Date;
}): Promise<"skipped" | "ok" | "missed" | "unavailable"> {
  let state = await deps.loadState();
  const metadata = await browser.storage.local.get([
    NOTIFIED_RESET_KEY,
    RETRY_AFTER_KEY,
  ]);
  const notifiedResetId: unknown = metadata[NOTIFIED_RESET_KEY];
  const retryAt: unknown = metadata[RETRY_AFTER_KEY];
  if (notifiedResetId !== undefined || retryAt !== undefined) {
    // Use the queued current state so migration cannot overwrite a newer patch.
    state = await deps.updateState((current) => ({
      missedAlertNotifiedResetId:
        current.missedAlertNotifiedResetId ??
        (typeof notifiedResetId === "string" && notifiedResetId.length > 0
          ? notifiedResetId
          : null),
      checkRetryAfterUntil:
        current.checkRetryAfterUntil ??
        (typeof retryAt === "number" && Number.isFinite(retryAt) && retryAt > 0
          ? retryAt
          : null),
    }));
    // Remove even invalid legacy values, only after the state write succeeds.
    await browser.storage.local.remove([NOTIFIED_RESET_KEY, RETRY_AFTER_KEY]);
  }
  if (state.mode !== "on") return "skipped";
  const now = deps.now();
  const at = now.toISOString();
  if (state.checkRetryAfterUntil !== null) {
    if (now.getTime() < state.checkRetryAfterUntil) return "unavailable";
    state = await deps.updateState({ checkRetryAfterUntil: null });
  }

  async function unavailable(detail: string): Promise<"unavailable"> {
    await deps.updateState({
      lastCheck: { at, outcome: "unavailable", detail },
    });
    return "unavailable";
  }

  let result: Awaited<ReturnType<typeof fetchStatus>>;
  try {
    result = await deps.fetchStatus(state.statusCache?.etag ?? null);
  } catch (error) {
    return unavailable(message(error));
  }
  state = await deps.loadState();
  if (state.mode !== "on") return "skipped";
  if (result.kind === "error") return unavailable(result.message);
  if (result.kind === "rate-limited") {
    const retrySeconds = Math.min(
      result.retryAfterSeconds,
      MAX_RETRY_AFTER_SECONDS,
    );
    await deps.updateState({
      checkRetryAfterUntil: now.getTime() + retrySeconds * 1000,
      lastCheck: {
        at,
        outcome: "unavailable",
        detail: "The API is rate limited. The check will retry later.",
      },
    });
    return "unavailable";
  }
  if (result.kind === "not-modified" && !state.statusCache) {
    return unavailable("The API returned 304 without cached status.");
  }

  const data = result.kind === "ok" ? result.data : state.statusCache!.data;
  if (result.kind === "ok") {
    state = await deps.updateState({
      statusCache: result.etag === null ? null : { etag: result.etag, data },
    });
  }
  const missed = findMissedReset({
    latestReset: data.latest_reset,
    enabledAt: state.enabledAt,
    lastResetAlert: state.lastResetAlert,
    now,
  });
  if (!missed) {
    await deps.updateState({ lastCheck: { at, outcome: "ok" } });
    return "ok";
  }

  if (
    state.failure?.missedResetId === missed.id ||
    state.missedAlertNotifiedResetId === missed.id
  ) {
    await deps.updateState({
      lastCheck: {
        at,
        outcome: "missed",
        detail: "This missed reset was already reported.",
      },
    });
    return "missed";
  }

  let failureReason = "The reset push alert was not received.";
  let endpoint: string | null = null;
  try {
    const registration = await deps.resubscribe();
    if (
      typeof registration !== "object" ||
      registration === null ||
      !("ok" in registration) ||
      registration.ok !== true
    ) {
      const reason =
        typeof registration === "object" &&
        registration !== null &&
        "reason" in registration &&
        typeof registration.reason === "string"
          ? registration.reason
          : "The server did not confirm registration.";
      throw new Error(reason);
    }
    if (
      "endpoint" in registration &&
      typeof registration.endpoint === "string"
    ) {
      endpoint = registration.endpoint;
    }
  } catch (error) {
    failureReason += ` Registering alerts again failed: ${message(error)}`;
  }

  await deps.updateState({
    endpoint,
    missedAlertNotifiedResetId: missed.id,
    failure: { at, reason: failureReason, missedResetId: missed.id },
    lastCheck: { at, outcome: "missed", detail: failureReason },
  });
  try {
    await deps.showMissedAlert(missed);
  } catch (error) {
    await deps.updateState({
      failure: {
        at,
        reason: `${failureReason} Notification failed: ${message(error)}`,
        missedResetId: missed.id,
      },
    });
  }
  return "missed";
}
