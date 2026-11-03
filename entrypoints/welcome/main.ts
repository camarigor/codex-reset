import { browser } from "wxt/browser";
import { SITE_ORIGIN } from "../../src/config";
import { sendToBackground } from "../../src/messages";
import { t, type MessageKey } from "../../src/ui/i18n";
import {
  describeToggleFailure,
  type StatusLine,
} from "../../src/ui/popup-model";

interface ElementType<T extends HTMLElement> {
  new (): T;
  prototype: T;
}

function byId<T extends HTMLElement>(id: string, type: ElementType<T>): T {
  const element = document.getElementById(id);
  if (!(element instanceof type))
    throw new Error(`Welcome page element #${id} is missing.`);
  return element;
}

const enableButton = byId("enable-alerts", HTMLButtonElement);
const result = byId("result", HTMLParagraphElement);

const STATIC_TEXT: ReadonlyArray<readonly [id: string, key: MessageKey]> = [
  ["welcome-title", "welcomeTitle"],
  ["welcome-intro", "welcomeIntro"],
  ["welcome-source", "welcomeSource"],
  ["consent-title", "welcomePrivacyHeading"],
  ["consent-subscription", "welcomePrivacySubscription"],
  ["consent-data", "welcomePrivacyData"],
  ["enable-alerts-label", "alertsTurnOn"],
  ["popup-hint", "welcomePopupHint"],
  ["credit-link", "creditLink"],
  ["disclaimer", "disclaimer"],
];

// What the page knows; render() draws it. alertsOn is null until the
// background answers. A failed attempt stays on screen until the next attempt
// or until alerts are on, so a state refresh never hides why it failed.
let alertsOn: boolean | null = null;
let turningOn = false;
let attemptFailure: string | null = null;
let stateError: string | null = null;

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : String(error);
}

function resultLine(): StatusLine {
  if (turningOn) return { tone: "off", text: t("alertsTurningOn") };
  if (alertsOn === true) return { tone: "ok", text: t("welcomeEnabled") };
  if (attemptFailure !== null) return { tone: "failing", text: attemptFailure };
  if (stateError !== null) return { tone: "failing", text: stateError };
  if (alertsOn === null) return { tone: "off", text: t("loading") };
  return { tone: "off", text: t("welcomeAlertsOff") };
}

function render(): void {
  const line = resultLine();
  result.dataset.tone = line.tone;
  result.textContent = line.text;
  // Once alerts are on, the popup is where they change.
  enableButton.hidden = alertsOn === true && !turningOn;
  enableButton.disabled =
    turningOn || (alertsOn === null && stateError === null);
}

async function refresh(): Promise<void> {
  try {
    const { state } = await sendToBackground({ type: "get-alert-state" });
    alertsOn = state.mode === "on";
    stateError = null;
  } catch (error) {
    // No state to report; say why instead of guessing whether alerts are on.
    alertsOn = null;
    stateError = errorMessage(error);
  }
  if (alertsOn) attemptFailure = null;
  render();
}

async function turnOn(): Promise<void> {
  const hadFocus = document.activeElement === enableButton;
  turningOn = true;
  attemptFailure = null;
  render();
  try {
    const response = await sendToBackground({ type: "enable-alerts" });
    alertsOn = response.state.mode === "on";
    stateError = null;
    if (!response.ok) {
      attemptFailure = describeToggleFailure(
        "enable-alerts",
        response.error,
        response.state.mode,
      );
    }
  } catch (error) {
    attemptFailure = describeToggleFailure(
      "enable-alerts",
      errorMessage(error),
      null,
    );
  } finally {
    turningOn = false;
  }
  render();
  // Disabling the button moved focus away; give it back while it is shown.
  if (hadFocus && !enableButton.hidden) enableButton.focus();
}

for (const [id, key] of STATIC_TEXT) byId(id, HTMLElement).textContent = t(key);
document.title = t("welcomeTitle");
byId("credit-link", HTMLAnchorElement).href = SITE_ORIGIN;
render();

enableButton.addEventListener("click", () => void turnOn());
// Alerts can also change from the popup while this tab is open.
browser.storage.onChanged.addListener((_changes, area) => {
  if (area === "local") void refresh();
});

void refresh();
