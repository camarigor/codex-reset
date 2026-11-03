import type { fetchStatus, Reset } from "../api/client";
import type { AlertState, loadState, updateState } from "../state/store";
import { findMissedReset } from "./missed-alert";

function message(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : "Unable to complete the missed-alert check.";
}

// Keep the notification marker when a push clears failure, without extending AlertState.
function notificationMarker(state: AlertState): string {
  return (
    state.lastCheck?.detail?.match(
      /Missed reset already notified: "(?:\\.|[^"\\])*"$/,
    )?.[0] ?? ""
  );
}

export async function runMissedAlertCheck(deps: {
  fetchStatus: typeof fetchStatus;
  loadState: typeof loadState;
  updateState: typeof updateState;
  showMissedAlert: (reset: Reset) => Promise<void>;
  resubscribe: () => Promise<unknown>;
  now: () => Date;
}): Promise<"skipped" | "ok" | "missed" | "unavailable"> {
  let state = await deps.loadState();
  if (state.mode !== "on") return "skipped";
  const now = deps.now();
  const at = now.toISOString();
  const retryAt =
    state.lastCheck?.outcome === "unavailable"
      ? state.lastCheck.detail?.match(/^Rate limited until (\S+)\./)?.[1]
      : undefined;
  if (retryAt && now.getTime() < Date.parse(retryAt)) return "unavailable";

  async function unavailable(detail: string): Promise<"unavailable"> {
    await deps.updateState((current) => ({
      lastCheck: {
        at,
        outcome: "unavailable",
        detail: [detail, notificationMarker(current)].filter(Boolean).join(" "),
      },
    }));
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
    const retry = new Date(now.getTime() + result.retryAfterSeconds * 1000);
    return unavailable(`Rate limited until ${retry.toISOString()}.`);
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
    const marker = notificationMarker(state);
    await deps.updateState({
      lastCheck: { at, outcome: "ok", ...(marker ? { detail: marker } : {}) },
    });
    return "ok";
  }

  const marker = `Missed reset already notified: ${JSON.stringify(missed.id)}`;
  if (
    state.failure?.missedResetId === missed.id ||
    notificationMarker(state) === marker
  ) {
    await deps.updateState({
      lastCheck: { at, outcome: "missed", detail: marker },
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
    failure: { at, reason: failureReason, missedResetId: missed.id },
    lastCheck: { at, outcome: "missed", detail: marker },
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
