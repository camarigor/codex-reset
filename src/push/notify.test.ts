import { describe, expect, it, vi } from "vitest";
import {
  showAlert,
  showMissedAlert,
  type MissedResetInfo,
  type NotificationHost,
} from "./notify";
import type { AlertPayload } from "./payload";

function createHost() {
  return {
    showNotification: vi
      .fn<NotificationHost["showNotification"]>()
      .mockResolvedValue(undefined),
    getNotifications: vi
      .fn<NotificationHost["getNotifications"]>()
      .mockResolvedValue([]),
  } satisfies NotificationHost;
}

const resetAlert: AlertPayload = {
  kind: "reset",
  title: "✅ Codex reset confirmed",
  body: "A Codex usage-limit reset was confirmed.",
  url: "https://codex-resets.com/",
};

const missedReset: MissedResetInfo = {
  resetType: "regular",
  text: "The usage limits were reset.",
  url: null,
};

describe("showAlert", () => {
  it("reset closes open watch notifications before showing", async () => {
    const host = createHost();
    const order: string[] = [];
    host.getNotifications.mockImplementation(async () => {
      order.push("get watches");
      return [
        {
          close: () => {
            order.push("close first watch");
          },
        },
        {
          close: () => {
            order.push("close second watch");
          },
        },
      ];
    });
    host.showNotification.mockImplementation(async () => {
      order.push("show reset");
    });

    await showAlert(host, resetAlert);

    expect(host.getNotifications).toHaveBeenCalledExactlyOnceWith({
      tag: "codex-reset-watch",
    });
    expect(order).toEqual([
      "get watches",
      "close first watch",
      "close second watch",
      "show reset",
    ]);
    expect(host.showNotification).toHaveBeenCalledExactlyOnceWith(
      "✅ Codex reset confirmed",
      {
        body: "A Codex usage-limit reset was confirmed.",
        tag: "codex-reset-confirmed",
        data: { url: "https://codex-resets.com/" },
      },
    );
  });

  it("watch uses the watch tag and does not close anything", async () => {
    const host = createHost();
    const close = vi.fn();
    host.getNotifications.mockResolvedValue([{ close }]);

    await showAlert(host, {
      kind: "watch",
      title: "⚠️ Possible Codex reset",
      body: "Prediction, not a confirmed reset.",
      url: "https://codex-resets.com/",
    });

    expect(host.getNotifications).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(host.showNotification).toHaveBeenCalledExactlyOnceWith(
      "⚠️ Possible Codex reset",
      {
        body: "Prediction, not a confirmed reset.",
        tag: "codex-reset-watch",
        data: { url: "https://codex-resets.com/" },
      },
    );
  });

  it.each(["watch", "reset"] as const)(
    "notification data carries the url: %j",
    async (kind) => {
      const host = createHost();
      const url = "https://example.com/announcement";

      await showAlert(host, { ...resetAlert, kind, url });

      expect(host.showNotification.mock.calls[0]?.[1]?.data).toEqual({ url });
    },
  );

  it("propagates notification display failures", async () => {
    const host = createHost();
    const error = new Error("Notifications unavailable");
    host.showNotification.mockRejectedValue(error);

    await expect(showAlert(host, resetAlert)).rejects.toBe(error);
  });

  it.each(["throws", "rejects"])(
    "shows a reset when retrieving watches fails: %j",
    async (failure) => {
      const host = createHost();
      const error = new Error("Cannot retrieve notifications");
      if (failure === "throws") {
        host.getNotifications.mockImplementation(() => {
          throw error;
        });
      } else {
        host.getNotifications.mockRejectedValue(error);
      }

      await showAlert(host, resetAlert);

      expect(host.showNotification).toHaveBeenCalledExactlyOnceWith(
        resetAlert.title,
        {
          body: resetAlert.body,
          tag: "codex-reset-confirmed",
          data: { url: resetAlert.url },
        },
      );
    },
  );

  it("shows a reset and closes remaining watches when one close throws", async () => {
    const host = createHost();
    const close = vi.fn();
    host.getNotifications.mockResolvedValue([
      {
        close: () => {
          throw new Error("Cannot close notification");
        },
      },
      { close },
    ]);

    await showAlert(host, resetAlert);

    expect(close).toHaveBeenCalledOnce();
    expect(host.showNotification).toHaveBeenCalledExactlyOnceWith(
      resetAlert.title,
      {
        body: resetAlert.body,
        tag: "codex-reset-confirmed",
        data: { url: resetAlert.url },
      },
    );
  });
});

describe("showMissedAlert", () => {
  it('missed alert uses the missed tag and the title "Push alert missed"', async () => {
    const host = createHost();

    await showMissedAlert(host, missedReset);

    expect(host.showNotification).toHaveBeenCalledExactlyOnceWith(
      "Push alert missed",
      {
        body: "Codex Resets reported a Regular reset that push did not deliver. Alerts were registered again.\n\nThe usage limits were reset.",
        tag: "codex-reset-missed",
        data: { url: "https://codex-resets.com/" },
      },
    );
    expect(host.getNotifications).not.toHaveBeenCalled();
  });

  it.each([
    ["regular", "Regular"],
    ["banked", "Banked"],
  ] as const)(
    "missed alert body names the reset type and says push did not deliver it: %j (%j)",
    async (resetType, label) => {
      const host = createHost();

      await showMissedAlert(host, { ...missedReset, resetType });

      expect(host.showNotification.mock.calls[0]?.[1]?.body).toBe(
        `Codex Resets reported a ${label} reset that push did not deliver. Alerts were registered again.\n\nThe usage limits were reset.`,
      );
    },
  );

  it.each(["javascript:alert(1)", "http://x", "", null])(
    "uses the site url for an unsafe or missing missed reset url: %j",
    async (url) => {
      const host = createHost();

      await showMissedAlert(host, { ...missedReset, url });

      expect(host.showNotification.mock.calls[0]?.[1]?.data).toEqual({
        url: "https://codex-resets.com/",
      });
    },
  );

  it("uses the missed reset source url when present", async () => {
    const host = createHost();
    const url = "https://example.com/reset";

    await showMissedAlert(host, { ...missedReset, url });

    expect(host.showNotification.mock.calls[0]?.[1]?.data).toEqual({ url });
  });
});
