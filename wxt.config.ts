import { defineConfig } from "wxt";

export default defineConfig({
  // Generates icons 16, 32, 48 and 128 from assets/icon.png.
  modules: ["@wxt-dev/auto-icons"],
  manifest: {
    name: "__MSG_extName__",
    description: "__MSG_extDescription__",
    permissions: ["notifications", "storage", "alarms"],
    optional_permissions: ["background"],
    host_permissions: ["https://codex-resets.com/*"],
    default_locale: "en",
  },
});
