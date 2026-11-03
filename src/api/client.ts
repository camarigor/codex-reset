import { ENDPOINTS, HISTORY_MAX_PAGES, RECENT_RESETS_LIMIT } from "../config";

export type ResetType = "regular" | "banked";

export interface ResetSource {
  type: "x_post" | "observed";
  author?: string;
  url?: string;
}

export interface Reset {
  id: string;
  reset_type: ResetType;
  announced_at: string;
  text: string;
  source: ResetSource;
}

export interface Stats {
  total: number;
  last_reset_at: string | null;
  days_since_last: number | null;
  avg_interval_days: number | null;
}

export interface StatusData {
  latest_reset: Reset | null;
  stats: Stats;
}

export type ApiResult<T> =
  | { kind: "ok"; data: T; etag: string | null }
  | { kind: "not-modified" }
  | { kind: "rate-limited"; retryAfterSeconds: number }
  | { kind: "error"; message: string };

type HistoryFailure = Extract<
  ApiResult<never>,
  { kind: "error" | "rate-limited" }
>;

export interface ResetHistory {
  resets: Reset[];
  firstPage: Reset[];
  complete: boolean;
  failure: HistoryFailure | null;
}

interface ResetPage {
  data: Reset[];
  pagination: { has_more: boolean; next_cursor: string | null };
}

const DEFAULT_RETRY_AFTER_SECONDS = 60;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isResetSource(value: unknown): value is ResetSource {
  return (
    isRecord(value) &&
    (value.type === "x_post" || value.type === "observed") &&
    (value.author === undefined || typeof value.author === "string") &&
    (value.url === undefined || typeof value.url === "string")
  );
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isReset(value: unknown): value is Reset {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    (value.reset_type === "regular" || value.reset_type === "banked") &&
    isTimestamp(value.announced_at) &&
    typeof value.text === "string" &&
    isResetSource(value.source)
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isStats(value: unknown): value is Stats {
  return (
    isRecord(value) &&
    isFiniteNumber(value.total) &&
    (value.last_reset_at === null || isTimestamp(value.last_reset_at)) &&
    (value.days_since_last === null || isFiniteNumber(value.days_since_last)) &&
    (value.avg_interval_days === null ||
      isFiniteNumber(value.avg_interval_days))
  );
}

function isStatusData(value: unknown): value is StatusData {
  return (
    isRecord(value) &&
    (value.latest_reset === null || isReset(value.latest_reset)) &&
    isStats(value.stats)
  );
}

function isResetList(value: unknown): value is Reset[] {
  return Array.isArray(value) && value.every(isReset);
}

function isResetPage(value: unknown): value is ResetPage {
  return (
    isRecord(value) &&
    isResetList(value.data) &&
    isRecord(value.pagination) &&
    typeof value.pagination.has_more === "boolean" &&
    (value.pagination.next_cursor === null
      ? !value.pagination.has_more
      : typeof value.pagination.next_cursor === "string" &&
        value.pagination.next_cursor.length > 0)
  );
}

function retryAfterSeconds(header: string | null): number {
  if (header === null) return DEFAULT_RETRY_AFTER_SECONDS;
  if (/^\d+$/.test(header)) {
    const seconds = Number(header);
    return Number.isSafeInteger(seconds)
      ? seconds
      : DEFAULT_RETRY_AFTER_SECONDS;
  }

  const isDated =
    /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(
      header,
    ) ||
    /^[A-Z][a-z]+, \d{2}-[A-Z][a-z]{2}-\d{2} \d{2}:\d{2}:\d{2} GMT$/.test(
      header,
    );
  const isAsctime =
    /^[A-Z][a-z]{2} [A-Z][a-z]{2} (?: \d|\d{2}) \d{2}:\d{2}:\d{2} \d{4}$/.test(
      header,
    );
  if (!isDated && !isAsctime) return DEFAULT_RETRY_AFTER_SECONDS;

  const retryAt = Date.parse(isAsctime ? `${header} GMT` : header);
  return Number.isFinite(retryAt)
    ? Math.max(0, Math.ceil((retryAt - Date.now()) / 1000))
    : DEFAULT_RETRY_AFTER_SECONDS;
}

async function requestData<T>(
  url: string,
  etag: string | null,
  validate: (value: unknown) => value is T,
  fetchFn: typeof fetch,
  selectData: (body: Record<string, unknown>) => unknown = (body) => body.data,
): Promise<ApiResult<T>> {
  try {
    const headers: Record<string, string> = { accept: "application/json" };
    if (etag !== null) headers["If-None-Match"] = etag;

    const response = await fetchFn(url, {
      cache: "no-store",
      headers,
      signal: AbortSignal.timeout(15000),
    });
    if (response.status === 304) return { kind: "not-modified" };
    if (response.status === 429) {
      return {
        kind: "rate-limited",
        retryAfterSeconds: retryAfterSeconds(
          response.headers.get("Retry-After"),
        ),
      };
    }
    if (!response.ok) {
      return {
        kind: "error",
        message: `API request failed (HTTP ${response.status}).`,
      };
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { kind: "error", message: "Invalid API response." };
    }
    if (!isRecord(body)) {
      return { kind: "error", message: "Invalid API response." };
    }
    const data = selectData(body);
    if (!validate(data)) {
      return { kind: "error", message: "Invalid API response." };
    }
    return { kind: "ok", data, etag: response.headers.get("ETag") };
  } catch (error) {
    return {
      kind: "error",
      message:
        error instanceof Error && error.message
          ? error.message
          : "Unable to fetch API data.",
    };
  }
}

export async function fetchStatus(
  etag: string | null,
  fetchFn: typeof fetch = fetch,
): Promise<ApiResult<StatusData>> {
  const result = await requestData(
    ENDPOINTS.status,
    etag,
    isStatusData,
    fetchFn,
  );
  if (result.kind !== "ok") return result;
  return {
    ...result,
    data: { latest_reset: result.data.latest_reset, stats: result.data.stats },
  };
}

export function fetchRecentResets(
  limit: number = RECENT_RESETS_LIMIT,
  fetchFn: typeof fetch = fetch,
): Promise<ApiResult<Reset[]>> {
  const requestedLimit = Number.isNaN(limit)
    ? RECENT_RESETS_LIMIT
    : Math.trunc(limit);
  const boundedLimit = Math.min(100, Math.max(1, requestedLimit));
  return requestData(
    `${ENDPOINTS.resets}?limit=${boundedLimit}`,
    null,
    isResetList,
    fetchFn,
  );
}

/** Reads one bounded burst, retaining validated pages if a later request fails. */
export async function fetchResetHistory(
  maxPages: number = HISTORY_MAX_PAGES,
  fetchFn: typeof fetch = fetch,
): Promise<ApiResult<ResetHistory>> {
  const pageLimit = Number.isFinite(maxPages)
    ? Math.min(HISTORY_MAX_PAGES, Math.max(1, Math.trunc(maxPages)))
    : HISTORY_MAX_PAGES;
  const history: ResetHistory = {
    resets: [],
    firstPage: [],
    complete: false,
    failure: null,
  };
  const cursors = new Set<string>();
  let cursor: string | null = null;

  for (let page = 0; page < pageLimit; page++) {
    const url = new URL(ENDPOINTS.resets);
    url.searchParams.set("limit", "100");
    if (cursor !== null) url.searchParams.set("cursor", cursor);
    const result = await requestData(
      url.href,
      null,
      isResetPage,
      fetchFn,
      (body) => body,
    );
    if (result.kind !== "ok") {
      if (page === 0) return result;
      history.failure =
        result.kind === "not-modified"
          ? { kind: "error", message: "Unexpected unchanged history page." }
          : result;
      return { kind: "ok", data: history, etag: null };
    }

    if (page === 0) history.firstPage = result.data.data;
    history.resets.push(...result.data.data);
    const { has_more, next_cursor } = result.data.pagination;
    if (!has_more) {
      history.complete = true;
      return { kind: "ok", data: history, etag: null };
    }
    // Validation guarantees a nonempty cursor whenever another page exists.
    if (next_cursor === null || cursors.has(next_cursor)) {
      history.failure = {
        kind: "error",
        message: "Reset history cursor repeated.",
      };
      return { kind: "ok", data: history, etag: null };
    }
    cursors.add(next_cursor);
    cursor = next_cursor;
  }

  history.failure = {
    kind: "error",
    message: "Reset history reached the page limit.",
  };
  return { kind: "ok", data: history, etag: null };
}
