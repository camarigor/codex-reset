export const SITE_ORIGIN = "https://codex-resets.com";
export const SITE_VAPID_PUBLIC_KEY =
  "BMw5OG-2Vl-saWPEafYmp_hcSzZVLaJAV6cyoX0bleDqY3f33d6gQ_oy3UWnRrmaks-jkSaY8cPJz7D1bDqw1NA";

export const ENDPOINTS = {
  subscribe: `${SITE_ORIGIN}/api/push/subscribe`,
  unsubscribe: `${SITE_ORIGIN}/api/push/unsubscribe`,
  status: `${SITE_ORIGIN}/api/v1/status`,
  resets: `${SITE_ORIGIN}/api/v1/resets`,
} as const;

export const CHECK_INTERVAL_MINUTES = 180;
export const STARTUP_CHECK_DELAY_MINUTES = 5;
export const MISSED_ALERT_GRACE_MINUTES = 30;
export const MISSED_ALERT_WINDOW_HOURS = 24;
export const RECENT_RESETS_LIMIT = 5;

export const NOTIFICATION_TAGS = {
  watch: "codex-reset-watch",
  reset: "codex-reset-confirmed",
  missed: "codex-reset-missed",
} as const;
