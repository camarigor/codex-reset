/// <reference lib="webworker" />

import { browser } from "wxt/browser";
import { defineBackground } from "wxt/utils/define-background";
import type { BackgroundRequest, BackgroundResponse } from "../src/messages";
import { showAlert } from "../src/push/notify";
import { parsePushPayload, sanitizeUrl } from "../src/push/payload";
import {
  disableAlerts,
  enableAlerts,
  resubscribe,
} from "../src/push/subscription";
import { loadState, updateState } from "../src/state/store";

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
        enqueue(async () => {
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
          });
        }),
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

    browser.runtime.onMessage.addListener(
      (request: unknown, sender, sendResponse) => {
        if (sender.id !== undefined && sender.id !== browser.runtime.id) return;
        if (!isRequest(request)) return;
        void enqueue(() => handleRequest(request))
          .catch(async (error: unknown): Promise<BackgroundResponse> => ({
            ok: false,
            error:
              error instanceof Error
                ? error.message
                : "Unable to update alert state.",
            state: await loadState(),
          }))
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
      if (request.type === "get-alert-state")
        return { ok: true, state: await loadState() };
      if (request.type === "enable-alerts") {
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
        return result.ok
          ? { ok: true, state }
          : { ok: false, error: result.reason, state };
      }
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
        failure: error ? { at: new Date().toISOString(), reason: error } : null,
      });
      return error ? { ok: false, error, state } : { ok: true, state };
    }
  },
});
