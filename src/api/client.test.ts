import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchRecentResets, fetchStatus } from "./client";

const latestReset = {
  id: "2117035794678546764",
  reset_type: "banked",
  announced_at: "2026-11-01T23:27:20.000Z",
  text: "Day 28/ Banked 2/2",
  source: {
    type: "x_post",
    author: "thsottiaux",
    url: "https://x.com/thsottiaux/status/2117035794678546764",
  },
};
const observedReset = {
  id: "observed-2114588174249071102",
  reset_type: "regular",
  announced_at: "2026-10-26T07:00:00.000Z",
  text: "Codex usage limits have been reset. Check your limits.",
  source: {
    type: "observed",
    url: "https://x.com/thsottiaux/status/2114588174249071102",
  },
};
const statusData = {
  latest_reset: latestReset,
  stats: {
    total: 71,
    last_reset_at: "2026-11-01T23:27:20.000Z",
    days_since_last: 0.9,
    avg_interval_days: 5.9,
  },
};
const statusSample = {
  data: { ...statusData, scheduled_reset: null, active_watch: null },
  meta: { api_version: "v1", generated_at: "2026-11-02T21:14:01.990Z" },
};
const recentSample = {
  data: [latestReset, observedReset],
  pagination: { has_more: true, next_cursor: "next-page" },
  meta: { api_version: "v1", generated_at: "2026-11-02T21:14:07.651Z" },
};

function fakeResponse(body: unknown, init?: ResponseInit) {
  return vi
    .fn<typeof fetch>()
    .mockImplementation(async () => Response.json(body, init));
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>().mockRejectedValue(new Error("Unexpected fetch call")),
  );
});
afterEach(() => {
  try {
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

describe("public API client", () => {
  it("sends If-None-Match when an etag is given", async () => {
    const fetchFn = fakeResponse(statusSample, {
      headers: { ETag: '"status-v2"' },
    });
    expect(await fetchStatus('"status-v1"', fetchFn)).toEqual({
      kind: "ok",
      data: statusData,
      etag: '"status-v2"',
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, options] = fetchFn.mock.calls[0] ?? [];
    expect(url).toBe("https://codex-resets.com/api/v1/status");
    expect(options?.cache).toBe("no-store");
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    const headers = new Headers(options?.headers);
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.get("If-None-Match")).toBe('"status-v1"');
  });

  it("maps 304 to not-modified", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response(null, { status: 304 }));
    expect(await fetchStatus('"status-v1"', fetchFn)).toEqual({
      kind: "not-modified",
    });
    expect(await fetchRecentResets(5, fetchFn)).toEqual({
      kind: "not-modified",
    });
  });

  it("maps 429 to rate-limited using Retry-After, defaulting to 60", async () => {
    const withHeader = fakeResponse(null, {
      status: 429,
      headers: { "Retry-After": "120" },
    });
    const withoutHeader = fakeResponse(null, { status: 429 });
    expect(await fetchStatus(null, withHeader)).toEqual({
      kind: "rate-limited",
      retryAfterSeconds: 120,
    });
    expect(await fetchRecentResets(5, withHeader)).toEqual({
      kind: "rate-limited",
      retryAfterSeconds: 120,
    });
    expect(await fetchStatus(null, withoutHeader)).toEqual({
      kind: "rate-limited",
      retryAfterSeconds: 60,
    });
    expect(await fetchRecentResets(5, withoutHeader)).toEqual({
      kind: "rate-limited",
      retryAfterSeconds: 60,
    });
  });

  it.each([
    ["0", 0],
    [null, 60],
    ["", 60],
    ["invalid", 60],
    ["-5", 60],
    ["1.5", 60],
    ["Infinity", 60],
    ["999999999999999999999", 60],
    ["Mon, 02 Nov 2026 12:02:00 GMT", 120],
    ["Monday, 02-Nov-26 12:02:00 GMT", 120],
    ["Mon Nov  2 12:02:00 2026", 120],
    ["Mon, 02 Nov 2026 11:59:00 GMT", 0],
    ["Mon, 99 Nov 2026 12:02:00 GMT", 60],
    ["2026-11-02T12:02:00.000Z", 60],
  ] as const)(
    "parses Retry-After %j as %i seconds",
    async (header, seconds) => {
      vi.spyOn(Date, "now").mockReturnValue(
        Date.parse("2026-11-02T12:00:00.250Z"),
      );
      const fetchFn = fakeResponse(null, {
        status: 429,
        headers: header === null ? {} : { "Retry-After": header },
      });
      const expected = { kind: "rate-limited", retryAfterSeconds: seconds };
      expect(await fetchStatus(null, fetchFn)).toEqual(expected);
      expect(await fetchRecentResets(5, fetchFn)).toEqual(expected);
    },
  );

  it.each([
    { status: 400, message: "API request failed (HTTP 400)." },
    { status: 500, message: "API request failed (HTTP 500)." },
    { status: 503, message: "API request failed (HTTP 503)." },
  ])(
    "rejects HTTP $status with valid bodies and the exact message",
    async ({ status, message }) => {
      const expected = { kind: "error", message };
      expect(
        await fetchStatus(null, fakeResponse(statusSample, { status })),
      ).toEqual(expected);
      expect(
        await fetchRecentResets(5, fakeResponse(recentSample, { status })),
      ).toEqual(expected);
    },
  );

  it.each([
    { error: new TypeError("Offline"), message: "Offline" },
    { error: "Offline", message: "Unable to fetch API data." },
  ])("maps 5xx and network errors to error", async ({ error, message }) => {
    const fetchFn = vi.fn<typeof fetch>().mockRejectedValue(error);
    expect(await fetchStatus(null, fetchFn)).toEqual({
      kind: "error",
      message,
    });
    expect(await fetchRecentResets(5, fetchFn)).toEqual({
      kind: "error",
      message,
    });
  });

  it("rejects a body without data.stats as error", async () => {
    expect(
      await fetchStatus(null, fakeResponse({ data: { latest_reset: null } })),
    ).toEqual({
      kind: "error",
      message: "Invalid API response.",
    });
  });

  it("fetchRecentResets requests limit=5 by default and returns data", async () => {
    const fetchFn = fakeResponse(recentSample);
    expect(await fetchRecentResets(undefined, fetchFn)).toEqual({
      kind: "ok",
      data: recentSample.data,
      etag: null,
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, options] = fetchFn.mock.calls[0] ?? [];
    expect(url).toBe("https://codex-resets.com/api/v1/resets?limit=5");
    expect(options?.cache).toBe("no-store");
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    expect(new Headers(options?.headers).get("accept")).toBe(
      "application/json",
    );
  });

  it("omits the conditional header when no etag is given", async () => {
    const fetchFn = fakeResponse(statusSample);
    expect(await fetchStatus(null, fetchFn)).toEqual({
      kind: "ok",
      data: statusData,
      etag: null,
    });
    expect(
      new Headers(fetchFn.mock.calls[0]?.[1]?.headers).has("If-None-Match"),
    ).toBe(false);
  });

  it("uses a caller-supplied recent limit and returns its etag", async () => {
    const fetchFn = fakeResponse(recentSample, {
      headers: { ETag: '"recent"' },
    });
    expect(await fetchRecentResets(2, fetchFn)).toEqual({
      kind: "ok",
      data: recentSample.data,
      etag: '"recent"',
    });
    expect(fetchFn.mock.calls[0]?.[0]).toBe(
      "https://codex-resets.com/api/v1/resets?limit=2",
    );
  });

  it.each([
    [-5, 1],
    [0, 1],
    [1.9, 1],
    [4.8, 4],
    [100, 100],
    [101, 100],
    [Infinity, 100],
    [-Infinity, 1],
    [NaN, 5],
  ])("clamps limit %s to integer %i", async (limit, expected) => {
    const fetchFn = fakeResponse(recentSample);
    expect(await fetchRecentResets(limit, fetchFn)).toMatchObject({
      kind: "ok",
    });
    expect(fetchFn.mock.calls[0]?.[0]).toBe(
      `https://codex-resets.com/api/v1/resets?limit=${expected}`,
    );
  });

  it("accepts nullable status fields and ignores fields outside the interface", async () => {
    const stats = {
      total: 0,
      last_reset_at: null,
      days_since_last: null,
      avg_interval_days: null,
    };
    const data = {
      latest_reset: null,
      stats,
      scheduled_reset: "not consumed",
      active_watch: "not consumed",
      unknown: true,
    };
    expect(await fetchStatus(null, fakeResponse({ data }))).toEqual({
      kind: "ok",
      data: { latest_reset: null, stats },
      etag: null,
    });
  });

  it.each([
    null,
    {},
    { data: null },
    { data: { stats: statusData.stats } },
    { data: { ...statusData, latest_reset: {} } },
    { data: { ...statusData, stats: null } },
    {
      data: {
        ...statusData,
        stats: { ...statusData.stats, last_reset_at: "not a date" },
      },
    },
    ...["total", "last_reset_at", "days_since_last", "avg_interval_days"].map(
      (field) => ({
        data: { ...statusData, stats: { ...statusData.stats, [field]: [] } },
      }),
    ),
  ])("rejects malformed status fields: %j", async (body) => {
    expect(await fetchStatus(null, fakeResponse(body))).toEqual({
      kind: "error",
      message: "Invalid API response.",
    });
  });

  it.each([
    { id: 42 },
    { reset_type: "scheduled" },
    { announced_at: null },
    { announced_at: "not a date" },
    { text: false },
    { source: null },
    { source: { type: "unknown" } },
    { source: { type: "x_post", author: 42 } },
    { source: { type: "observed", url: 42 } },
  ])("rejects malformed reset fields in both endpoints: %j", async (patch) => {
    const reset = { ...latestReset, ...patch };
    expect(
      await fetchStatus(
        null,
        fakeResponse({ data: { ...statusData, latest_reset: reset } }),
      ),
    ).toEqual({ kind: "error", message: "Invalid API response." });
    expect(await fetchRecentResets(5, fakeResponse({ data: [reset] }))).toEqual(
      { kind: "error", message: "Invalid API response." },
    );
  });

  it("accepts an observed source without optional fields and an empty reset list", async () => {
    const data = [{ ...observedReset, source: { type: "observed" } }];
    expect(await fetchRecentResets(5, fakeResponse({ data }))).toEqual({
      kind: "ok",
      data,
      etag: null,
    });
    expect(await fetchRecentResets(5, fakeResponse({ data: [] }))).toEqual({
      kind: "ok",
      data: [],
      etag: null,
    });
  });

  it.each([{}, { data: null }, { data: {} }, { data: [null] }])(
    "rejects a malformed reset list: %j",
    async (body) => {
      expect(await fetchRecentResets(5, fakeResponse(body))).toEqual({
        kind: "error",
        message: "Invalid API response.",
      });
    },
  );

  it.each(["invalid JSON", ""])(
    "maps invalid JSON %j to a stable error message",
    async (body) => {
      const fetchFn = vi
        .fn<typeof fetch>()
        .mockImplementation(async () => new Response(body));
      expect(await fetchStatus(null, fetchFn)).toEqual({
        kind: "error",
        message: "Invalid API response.",
      });
      expect(await fetchRecentResets(5, fetchFn)).toEqual({
        kind: "error",
        message: "Invalid API response.",
      });
    },
  );

  it("uses a 15000 ms timeout for both functions", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    await fetchStatus(null, fakeResponse(statusSample));
    await fetchRecentResets(5, fakeResponse(recentSample));
    expect(timeout.mock.calls).toEqual([[15000], [15000]]);
  });
});
