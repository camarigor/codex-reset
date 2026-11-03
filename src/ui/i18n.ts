import { browser } from "wxt/browser";

/**
 * A message name from public/_locales/en/messages.json. WXT generates the
 * union from that file, so an unknown key fails the type check instead of
 * rendering an empty string at runtime.
 */
export type MessageKey = Parameters<typeof browser.i18n.getMessage>[0];

/**
 * Returns the message for `key` in the browser's language (English when it
 * has no translation), with its placeholders filled from `substitutions`
 * in order.
 */
export function t(key: MessageKey, substitutions?: string[]): string {
  return browser.i18n.getMessage(key, substitutions);
}
