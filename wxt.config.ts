import { defineConfig } from "wxt";

export default defineConfig({
  manifest: {
    permissions: ["notifications", "storage", "alarms"],
    optional_permissions: ["background"],
    host_permissions: ["https://codex-resets.com/*"],
    default_locale: "en",
  },
});
