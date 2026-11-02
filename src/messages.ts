import { browser } from "wxt/browser";
import type { AlertState } from "./state/store";

export type BackgroundRequest =
  | { type: "get-alert-state" }
  | { type: "enable-alerts" }
  | { type: "disable-alerts" };

export type BackgroundResponse =
  | { ok: true; state: AlertState }
  | { ok: false; error: string; state: AlertState };

export function sendToBackground(
  request: BackgroundRequest,
): Promise<BackgroundResponse> {
  return browser.runtime.sendMessage(request);
}
