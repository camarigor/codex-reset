import { browser, type Browser } from "wxt/browser";
import {
  fetchRecentResets,
  fetchStatus,
  type Reset,
  type StatusData,
} from "../../src/api/client";
import { SITE_ORIGIN } from "../../src/config";
import { sendToBackground } from "../../src/messages";
import type { AlertState } from "../../src/state/store";
import { formatDays } from "../../src/ui/format";
import { t, type MessageKey } from "../../src/ui/i18n";
import {
  buildResetView,
  buildStatusLine,
  combineResults,
  describeToggleFailure,
  type PopupData,
  type ResetView,
  type StatusLine,
  type ToggleRequest,
} from "../../src/ui/popup-model";

interface ElementType<T extends HTMLElement> {
  new (): T;
  prototype: T;
}

function byId<T extends HTMLElement>(id: string, type: ElementType<T>): T {
  const element = document.getElementById(id);
  if (!(element instanceof type))
    throw new Error(`Popup element #${id} is missing.`);
  return element;
}

function field<T extends HTMLElement>(
  root: ParentNode,
  name: string,
  type: ElementType<T>,
): T {
  const element = root.querySelector(`[data-field="${name}"]`);
  if (!(element instanceof type))
    throw new Error(`Popup field ${name} is missing.`);
  return element;
}

/** Creates an element with the given properties, for the markup built here. */
function create<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  properties: Partial<HTMLElementTagNameMap[K]>,
): HTMLElementTagNameMap[K] {
  return Object.assign(document.createElement(tag), properties);
}

const toggle = byId("alerts-toggle", HTMLButtonElement);
const statusLine = byId("status-line", HTMLParagraphElement);
const toggleHint = byId("toggle-hint", HTMLParagraphElement);
const resetData = byId("reset-data", HTMLElement);
const dataStatus = byId("data-status", HTMLDivElement);
const dataMessage = byId("data-message", HTMLParagraphElement);
const retry = byId("retry", HTMLButtonElement);
const data = byId("data", HTMLDivElement);
const latestReset = byId("latest-reset", HTMLDivElement);
const noLatestReset = byId("no-latest-reset", HTMLParagraphElement);
const statsTotal = byId("stats-total", HTMLElement);
const statsAverage = byId("stats-average", HTMLElement);
const statsSince = byId("stats-since", HTMLElement);
const recentList = byId("recent-list", HTMLOListElement);
const recentEmpty = byId("recent-empty", HTMLParagraphElement);
const resetItem = byId("reset-item", HTMLTemplateElement);

// "Keep alerts with Chrome closed" asks for the optional background
// permission. The popup markup has no slot for it, so it is built here from
// the classes of the alerts area, between the alerts and the reset data.
const BACKGROUND: Browser.permissions.Permissions = {
  permissions: ["background"],
};
const backgroundToggle = create("button", {
  id: "background-toggle",
  className: "button",
  type: "button",
  disabled: true,
  textContent: t("backgroundToggle"),
});
const backgroundNote = create("p", {
  id: "background-note",
  className: "toggle-hint",
});
const linuxNote = create("p", {
  className: "toggle-hint",
  hidden: true,
  textContent: t("backgroundLinuxNote"),
});
backgroundToggle.setAttribute("aria-pressed", "false");
backgroundToggle.setAttribute("aria-describedby", backgroundNote.id);
backgroundNote.setAttribute("aria-live", "polite");
const backgroundOption = create("div", { className: "alerts" });
backgroundOption.append(backgroundToggle, backgroundNote, linuxNote);
resetData.before(backgroundOption);

// While the toggle would turn alerts on, it sits next to what that sends, so
// consent never depends on having read the welcome page.
const PRIVACY_POLICY_URL = "https://camarigor.github.io/codex-reset/privacy/";
const disclosure = create("p", {
  id: "alerts-disclosure",
  className: "toggle-hint",
  hidden: true,
});
disclosure.append(
  t("alertsDisclosure"),
  " ",
  create("a", {
    href: PRIVACY_POLICY_URL,
    target: "_blank",
    rel: "noopener noreferrer",
    textContent: t("privacyPolicyLink"),
  }),
);
toggleHint.after(disclosure);

const STATIC_TEXT: ReadonlyArray<readonly [id: string, key: MessageKey]> = [
  ["popup-title", "popupTitle"],
  ["alerts-toggle-label", "alertsToggle"],
  ["latest-label", "latestResetLabel"],
  ["no-latest-reset", "noResetsYet"],
  ["stats-total-label", "statsTotal"],
  ["stats-average-label", "statsAverageInterval"],
  ["stats-since-label", "statsSinceLast"],
  ["recent-heading", "recentResetsHeading"],
  ["recent-empty", "noResetsYet"],
  ["retry", "retry"],
  ["credit-link", "creditLink"],
  ["disclaimer", "disclaimer"],
];

// Longest delay setTimeout accepts; a longer one fires at once.
const MAX_TIMER_MS = 2 ** 31 - 1;

let alertMode: AlertState["mode"] | null = null;
let toggleBusy = false;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
// null until permissions.contains answers, or when it failed.
let backgroundGranted: boolean | null = null;
let backgroundBusy = false;
let backgroundProblem: string | null = null;

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : String(error);
}

/** Ends a reason that closes a message as a sentence. */
function asSentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/**
 * describeToggleFailure words a failed turn-off only when alerts ended off.
 * This adds the message for one that left alerts on, or whose outcome is
 * unknown because the background did not answer.
 */
function describeFailure(
  request: ToggleRequest,
  reason: string,
  mode: AlertState["mode"] | null,
): string {
  return request === "disable-alerts" && mode !== "off"
    ? t("alertsDisableFailed", [asSentence(reason)])
    : describeToggleFailure(request, reason, mode);
}

function renderStatus(line: StatusLine): void {
  statusLine.dataset.tone = line.tone;
  statusLine.textContent = line.text;
}

/**
 * Shows the disclosure whenever a click on the toggle would turn alerts on,
 * including when their state is unknown. Screen readers hear it with the
 * toggle only while it is shown.
 */
function renderDisclosure(): void {
  disclosure.hidden = alertMode === "on";
  toggle.setAttribute(
    "aria-describedby",
    disclosure.hidden ? statusLine.id : `${statusLine.id} ${disclosure.id}`,
  );
}

function renderAlertState(state: AlertState): void {
  alertMode = state.mode;
  const on = state.mode === "on";
  toggle.setAttribute("aria-pressed", String(on));
  toggle.title = t(on ? "alertsTurnOff" : "alertsTurnOn");
  renderStatus(buildStatusLine(state, new Date()));
  renderDisclosure();
}

async function refreshAlertState(): Promise<void> {
  try {
    renderAlertState(
      (await sendToBackground({ type: "get-alert-state" })).state,
    );
  } catch (error) {
    // No state to report; say why instead of guessing whether alerts are on.
    renderStatus({ tone: "failing", text: errorMessage(error) });
    renderDisclosure();
  } finally {
    if (!toggleBusy) toggle.disabled = false;
  }
}

async function switchAlerts(): Promise<void> {
  const request: ToggleRequest =
    alertMode === "on" ? "disable-alerts" : "enable-alerts";
  const hadFocus = document.activeElement === toggle;
  toggleBusy = true;
  toggle.disabled = true;
  toggleHint.textContent = t(
    request === "enable-alerts" ? "alertsTurningOn" : "alertsTurningOff",
  );
  try {
    const response = await sendToBackground({ type: request });
    renderAlertState(response.state);
    toggleHint.textContent = response.ok
      ? ""
      : describeFailure(request, response.error, response.state.mode);
  } catch (error) {
    toggleHint.textContent = describeFailure(
      request,
      errorMessage(error),
      null,
    );
  } finally {
    toggleBusy = false;
    toggle.disabled = false;
    // Disabling the button moved focus away; give it back to keyboard users.
    if (hadFocus) toggle.focus();
  }
}

function renderBackground(): void {
  backgroundToggle.setAttribute(
    "aria-pressed",
    String(backgroundGranted === true),
  );
  // Clickable once the state is known, or after reading it failed.
  backgroundToggle.disabled =
    backgroundBusy ||
    (backgroundGranted === null && backgroundProblem === null);
  const stateNote =
    backgroundGranted === null
      ? null
      : t(backgroundGranted ? "backgroundOnNote" : "backgroundOffNote");
  backgroundNote.textContent = [backgroundProblem, stateNote]
    .filter((text) => text !== null)
    .join(" ");
}

async function refreshBackground(): Promise<void> {
  try {
    backgroundGranted = await browser.permissions.contains(BACKGROUND);
  } catch (error) {
    backgroundGranted = null;
    backgroundProblem = errorMessage(error);
  }
  renderBackground();
}

function switchBackground(): void {
  const grant = backgroundGranted !== true;
  // permissions.request only works during the click's user gesture, so it
  // starts before anything else awaits.
  const change = grant
    ? browser.permissions.request(BACKGROUND)
    : browser.permissions.remove(BACKGROUND);
  const hadFocus = document.activeElement === backgroundToggle;
  backgroundBusy = true;
  backgroundProblem = null;
  renderBackground();
  void change
    .then(
      (changed) => {
        if (grant && !changed) backgroundProblem = t("backgroundDenied");
      },
      (error: unknown) => {
        backgroundProblem = t("backgroundFailed", [
          asSentence(errorMessage(error)),
        ]);
      },
    )
    .then(async () => {
      backgroundBusy = false;
      // The state shown always comes from Chrome, not from the answer above.
      await refreshBackground();
      if (hadFocus) backgroundToggle.focus();
    });
}

/** Follows changes made elsewhere: another popup, or Chrome itself. */
function followBackgroundChange(
  permissions: Browser.permissions.Permissions,
): void {
  if (!permissions.permissions?.includes("background")) return;
  backgroundProblem = null;
  void refreshBackground();
}

function fillReset(root: ParentNode, view: ResetView): void {
  for (const [name, text] of [
    ["relative", view.relativeTime],
    ["exact", view.exactTime],
  ] as const) {
    const time = field(root, name, HTMLTimeElement);
    time.dateTime = view.datetime;
    time.textContent = text;
  }

  const type = field(root, "type", HTMLElement);
  type.dataset.type = view.type;
  type.textContent = view.typeLabel;
  field(root, "text", HTMLElement).textContent = view.text;

  const link = field(root, "link", HTMLAnchorElement);
  link.hidden = view.source.kind !== "link";
  if (view.source.kind === "link") link.href = view.source.url;
  else link.removeAttribute("href");
  link.textContent = t("viewAnnouncement");

  const note = field(root, "observed", HTMLElement);
  note.hidden = view.source.kind !== "observed";
  note.textContent = t("resetObserved");
}

function resetListItem(view: ResetView): HTMLLIElement {
  const item = resetItem.content.firstElementChild?.cloneNode(true);
  if (!(item instanceof HTMLLIElement)) {
    throw new Error("Popup template #reset-item is missing its item.");
  }
  fillReset(item, view);
  return item;
}

function renderData(status: StatusData, resets: Reset[]): void {
  const now = new Date();
  const latest = status.latest_reset;
  latestReset.hidden = latest === null;
  noLatestReset.hidden = latest !== null;
  if (latest !== null) fillReset(latestReset, buildResetView(latest, now));

  statsTotal.textContent = String(status.stats.total);
  statsAverage.textContent = formatDays(status.stats.avg_interval_days);
  statsSince.textContent = formatDays(status.stats.days_since_last);

  recentList.replaceChildren(
    ...resets.map((reset) => resetListItem(buildResetView(reset, now))),
  );
  recentList.hidden = resets.length === 0;
  recentEmpty.hidden = resets.length > 0;

  dataStatus.hidden = true;
  data.hidden = false;
  resetData.setAttribute("aria-busy", "false");
}

function renderDataProblem(
  problem: Exclude<PopupData, { kind: "ready" }> | { kind: "loading" },
): void {
  clearTimeout(retryTimer);
  resetData.setAttribute("aria-busy", String(problem.kind === "loading"));
  data.hidden = true;
  dataStatus.hidden = false;
  dataMessage.textContent = t(
    problem.kind === "loading"
      ? "loading"
      : problem.kind === "error"
        ? "loadFailed"
        : "loadRateLimited",
  );
  retry.hidden = problem.kind === "loading";

  // Honor Retry-After: the popup must not load codex-resets.com harder than the site.
  const waitMs =
    problem.kind === "rate-limited" ? problem.retryAfterSeconds * 1000 : 0;
  retry.disabled = waitMs > 0;
  if (waitMs > 0) {
    retryTimer = setTimeout(
      () => {
        retry.disabled = false;
      },
      Math.min(waitMs, MAX_TIMER_MS),
    );
  }
}

async function loadResetData(): Promise<void> {
  renderDataProblem({ kind: "loading" });
  let result: PopupData;
  try {
    const [status, resets] = await Promise.all([
      fetchStatus(null),
      fetchRecentResets(),
    ]);
    result = combineResults(status, resets);
  } catch {
    // The client reports failures as results; anything thrown still means no data.
    result = { kind: "error" };
  }
  if (result.kind === "ready") renderData(result.status, result.resets);
  else renderDataProblem(result);
}

for (const [id, key] of STATIC_TEXT) byId(id, HTMLElement).textContent = t(key);
document.title = t("popupTitle");
byId("credit-link", HTMLAnchorElement).href = SITE_ORIGIN;
toggle.title = t("alertsTurnOn");
renderStatus({ tone: "off", text: t("loading") });

toggle.addEventListener("click", () => void switchAlerts());
retry.addEventListener("click", () => void loadResetData());
backgroundToggle.addEventListener("click", switchBackground);
// The background records alerts and checks while the popup is open.
browser.storage.onChanged.addListener((_changes, area) => {
  if (area === "local") void refreshAlertState();
});
browser.permissions.onAdded.addListener(followBackgroundChange);
browser.permissions.onRemoved.addListener(followBackgroundChange);
// The note names Linux itself, so it stays correct where the platform is unknown.
void browser.runtime.getPlatformInfo().then(
  ({ os }) => {
    linuxNote.hidden = os !== "linux";
  },
  () => {
    linuxNote.hidden = false;
  },
);

void refreshAlertState();
void refreshBackground();
void loadResetData();
