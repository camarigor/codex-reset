/// <reference lib="webworker" />

import { browser } from "wxt/browser";
import { defineBackground } from "wxt/utils/define-background";
import { fetchStatus } from "../src/api/client";
import { runMissedAlertCheck } from "../src/check/run-check";
import {
  CHECK_INTERVAL_MINUTES,
  NOTIFICATION_TAGS,
  STARTUP_CHECK_DELAY_MINUTES,
} from "../src/config";
import type { BackgroundRequest, BackgroundResponse } from "../src/messages";
import {
  showAlert,
  showMissedAlert,
  type MissedResetInfo,
} from "../src/push/notify";
import { parsePushPayload, sanitizeUrl } from "../src/push/payload";
import {
  disableAlerts,
  enableAlerts,
  resubscribe,
} from "../src/push/subscription";
import { DEFAULT_STATE, loadState, updateState } from "../src/state/store";
import { stripShortLinks } from "../src/ui/format";

function isRequest(value: unknown): value is BackgroundRequest {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    (value.type === "get-alert-state" ||
      value.type === "enable-alerts" ||
      value.type === "disable-alerts")
  );
}

export default defineBackground({
  type: "module",
  main() {
    const worker = self as unknown as ServiceWorkerGlobalScope;
    let pending: Promise<void> = Promise.resolve();

    worker.addEventListener("push", (event) => {
      event.waitUntil(
        (async () => {
          const alert = parsePushPayload(event.data?.text() ?? null);
          const at = new Date().toISOString();
          await showAlert(worker.registration, alert);
          await updateState({
            lastAlert: {
              at,
              kind: alert.kind,
              title: alert.title,
              url: alert.url,
            },
            ...(alert.kind === "reset"
              ? { lastResetAlert: { at, url: alert.url } }
              : {}),
            failure: null,
          }).catch(() => {
            // Recording must not reject a push whose notification was shown.
          });
        })(),
      );
    });

    worker.addEventListener("notificationclick", (event) => {
      event.notification.close();
      const data: unknown = event.notification.data;
      const url =
        typeof data === "object" && data !== null && "url" in data
          ? data.url
          : null;
      event.waitUntil(browser.tabs.create({ url: sanitizeUrl(url) }));
    });

    worker.addEventListener("pushsubscriptionchange", (event) => {
      event.waitUntil(
        enqueue(async () => {
          if ((await loadState()).mode !== "on") return;
          const result = await resubscribe(worker.registration.pushManager);
          await updateState(
            result.ok
              ? { endpoint: result.endpoint }
              : {
                  endpoint: null,
                  failure: {
                    at: new Date().toISOString(),
                    reason: result.reason,
                  },
                },
          );
        }),
      );
    });

    browser.runtime.onInstalled.addListener(({ reason }) => {
      // Alerts start off: the welcome page asks for consent before anything
      // is sent to codex-resets.com. Updates must not open it again.
      if (reason === "install") {
        void browser.tabs.create({
          url: browser.runtime.getURL("/welcome.html"),
        });
      }
      return enqueue(ensurePeriodicCheck);
    });
    browser.runtime.onStartup.addListener(() =>
      enqueue(async () => {
        await ensurePeriodicCheck();
        await browser.alarms.create("missed-alert-check-startup", {
          delayInMinutes: STARTUP_CHECK_DELAY_MINUTES,
        });
      }),
    );
    browser.alarms.onAlarm.addListener((alarm) => {
      if (
        alarm.name !== "missed-alert-check" &&
        alarm.name !== "missed-alert-check-startup"
      )
        return;
      return enqueue(async () => {
        try {
          if (
            Date.now() - alarm.scheduledTime >
            STARTUP_CHECK_DELAY_MINUTES * 60_000
          ) {
            await browser.alarms.create("missed-alert-check-startup", {
              delayInMinutes: STARTUP_CHECK_DELAY_MINUTES,
            });
            return;
          }
          let registeredAgain = false;
          await runMissedAlertCheck({
            fetchStatus,
            loadState,
            updateState,
            now: () => new Date(),
            resubscribe: async () => {
              const result = await resubscribe(worker.registration.pushManager);
              registeredAgain = result.ok;
              return result;
            },
            showMissedAlert: async (reset) => {
              const missed: MissedResetInfo = {
                resetType: reset.reset_type,
                text: stripShortLinks(reset.text),
                url: sanitizeUrl(reset.source.url),
              };
              if (registeredAgain) {
                await showMissedAlert(worker.registration, missed);
                return;
              }
              const resetType =
                missed.resetType === "regular" ? "Regular" : "Banked";
              await worker.registration.showNotification("Push alert missed", {
                body: `Codex Resets reported a ${resetType} reset that push did not deliver. Registering alerts again failed.\n\n${missed.text}`,
                tag: NOTIFICATION_TAGS.missed,
                data: { url: missed.url },
              });
            },
          });
        } catch (error) {
          await recordCheckUnavailable(error);
        }
      });
    });

    async function recordCheckUnavailable(error: unknown): Promise<void> {
      await updateState({
        lastCheck: {
          at: new Date().toISOString(),
          outcome: "unavailable",
          detail:
            error instanceof Error && error.message
              ? error.message
              : "Unable to complete the missed-alert check.",
        },
      }).catch(() => {
        // Storage may also be unavailable when recording the check failure.
      });
    }

    async function ensurePeriodicCheck(): Promise<void> {
      if (!(await browser.alarms.get("missed-alert-check"))) {
        await browser.alarms.create("missed-alert-check", {
          periodInMinutes: CHECK_INTERVAL_MINUTES,
        });
      }
    }

    browser.runtime.onMessage.addListener(
      (request: unknown, sender, sendResponse) => {
        if (sender.id !== undefined && sender.id !== browser.runtime.id) return;
        if (!isRequest(request)) return;
        void handleRequest(request)
          .catch(async (error: unknown): Promise<BackgroundResponse> => {
            let state = DEFAULT_STATE;
            try {
              state = await loadState();
            } catch {
              // A storage failure must still produce a response.
            }
            return {
              ok: false,
              error:
                error instanceof Error
                  ? error.message
                  : "Unable to update alert state.",
              state,
            };
          })
          .then(sendResponse);
        return true;
      },
    );

    // Keep lifecycle operations and their state writes together across rapid toggles.
    function enqueue<T>(operation: () => Promise<T>): Promise<T> {
      const result = pending.then(operation);
      pending = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    }

    async function handleRequest(
      request: BackgroundRequest,
    ): Promise<BackgroundResponse> {
      switch (request.type) {
        case "get-alert-state":
          return { ok: true, state: await loadState() };
        case "enable-alerts":
          return enqueue(async () => {
            const previous = await loadState();
            const result = await enableAlerts(worker.registration.pushManager);
            const at = new Date().toISOString();
            const state = await updateState(
              result.ok
                ? {
                    mode: "on",
                    enabledAt:
                      previous.mode === "on" ? (previous.enabledAt ?? at) : at,
                    endpoint: result.endpoint,
                    failure: null,
                  }
                : {
                    mode: "off",
                    enabledAt: null,
                    endpoint: null,
                    failure: { at, reason: result.reason },
                  },
            );
            if (result.ok) await ensurePeriodicCheck();
            return result.ok
              ? { ok: true, state }
              : { ok: false, error: result.reason, state };
          });
        case "disable-alerts":
          return enqueue(async () => {
            const result = await disableAlerts(worker.registration.pushManager);
            const error =
              result.reason ??
              (result.serverNotified
                ? null
                : "The server could not be notified that alerts are off.");
            const state = await updateState({
              mode: "off",
              enabledAt: null,
              endpoint: null,
              failure: error
                ? { at: new Date().toISOString(), reason: error }
                : null,
            });
            return error ? { ok: false, error, state } : { ok: true, state };
          });
        default: {
          const exhaustive: never = request;
          return exhaustive;
        }
      }
    }

    return enqueue(ensurePeriodicCheck).catch(recordCheckUnavailable);
  },
});
