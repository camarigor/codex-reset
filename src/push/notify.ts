import { NOTIFICATION_TAGS } from "../config";
import { sanitizeUrl, type AlertPayload } from "./payload";

export interface NotificationHost {
  showNotification(title: string, options?: NotificationOptions): Promise<void>;
  getNotifications(filter?: {
    tag?: string;
  }): Promise<Array<{ close(): void }>>;
}

export interface MissedResetInfo {
  resetType: "regular" | "banked";
  text: string;
  url: string | null;
}

export async function showAlert(
  host: NotificationHost,
  alert: AlertPayload,
): Promise<void> {
  if (alert.kind === "reset") {
    try {
      const watches = await host.getNotifications({
        tag: NOTIFICATION_TAGS.watch,
      });
      for (const notification of watches) {
        try {
          notification.close();
        } catch {
          // One stale watch must not block the reset or closing other watches.
        }
      }
    } catch {
      // Watch cleanup is best effort; the reset still needs to be shown.
    }
  }

  await host.showNotification(alert.title, {
    body: alert.body,
    tag: NOTIFICATION_TAGS[alert.kind],
    data: { url: alert.url },
  });
}

export async function showMissedAlert(
  host: NotificationHost,
  missed: MissedResetInfo,
): Promise<void> {
  const resetType = missed.resetType === "regular" ? "Regular" : "Banked";
  await host.showNotification("Push alert missed", {
    body: `Codex Resets reported a ${resetType} reset that push did not deliver. Alerts were registered again.\n\n${missed.text}`,
    tag: NOTIFICATION_TAGS.missed,
    data: { url: sanitizeUrl(missed.url) },
  });
}
