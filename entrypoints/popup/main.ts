import { browser } from "wxt/browser";
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

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : String(error);
}

function renderStatus(line: StatusLine): void {
  statusLine.dataset.tone = line.tone;
  statusLine.textContent = line.text;
}

function renderAlertState(state: AlertState): void {
  alertMode = state.mode;
  const on = state.mode === "on";
  toggle.setAttribute("aria-pressed", String(on));
  toggle.title = t(on ? "alertsTurnOff" : "alertsTurnOn");
  renderStatus(buildStatusLine(state, new Date()));
}

async function refreshAlertState(): Promise<void> {
  try {
    renderAlertState(
      (await sendToBackground({ type: "get-alert-state" })).state,
    );
  } catch (error) {
    // No state to report; say why instead of guessing whether alerts are on.
    renderStatus({ tone: "failing", text: errorMessage(error) });
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
      : describeToggleFailure(request, response.error, response.state.mode);
  } catch (error) {
    toggleHint.textContent = describeToggleFailure(
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
// The background records alerts and checks while the popup is open.
browser.storage.onChanged.addListener((_changes, area) => {
  if (area === "local") void refreshAlertState();
});

void refreshAlertState();
void loadResetData();
