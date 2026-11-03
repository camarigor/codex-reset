import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HISTORY_MAX_PAGES } from "../config";
import { fetchRecentResets, fetchResetHistory, fetchStatus } from "./client";

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

describe("reset history pagination", () => {
  function page(data: unknown[], cursor: string | null = null) {
    return {
      data,
      pagination: { has_more: cursor !== null, next_cursor: cursor },
    };
  }

  it.each([{ data: [] }, { data: [latestReset, observedReset] }])(
    "reads a single complete page: %j",
    async ({ data }) => {
      const fetchFn = fakeResponse(page(data));
      expect(await fetchResetHistory(undefined, fetchFn)).toEqual({
        kind: "ok",
        etag: null,
        data: { resets: data, firstPage: data, complete: true, failure: null },
      });
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(fetchFn.mock.calls[0]?.[0]).toBe(
        "https://codex-resets.com/api/v1/resets?limit=100",
      );
      const options = fetchFn.mock.calls[0]?.[1];
      expect(options?.cache).toBe("no-store");
      expect(new Headers(options?.headers).has("If-None-Match")).toBe(false);
    },
  );

  it("follows several pages past 100 resets and preserves the first page", async () => {
    const resets = Array.from({ length: 201 }, (_, index) => ({
      ...latestReset,
      id: String(index),
    }));
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json(page(resets.slice(0, 100), "opaque_cursor-1")),
      )
      .mockResolvedValueOnce(
        Response.json(page(resets.slice(100, 200), "opaque_cursor-2")),
      )
      .mockResolvedValueOnce(Response.json(page(resets.slice(200))));
    const timeout = vi.spyOn(AbortSignal, "timeout");
    expect(await fetchResetHistory(undefined, fetchFn)).toEqual({
      kind: "ok",
      etag: null,
      data: {
        resets,
        firstPage: resets.slice(0, 100),
        complete: true,
        failure: null,
      },
    });
    expect(fetchFn.mock.calls.map(([url]) => String(url))).toEqual([
      "https://codex-resets.com/api/v1/resets?limit=100",
      "https://codex-resets.com/api/v1/resets?limit=100&cursor=opaque_cursor-1",
      "https://codex-resets.com/api/v1/resets?limit=100&cursor=opaque_cursor-2",
    ]);
    expect(timeout.mock.calls).toEqual([[15000], [15000], [15000]]);
    expect(
      fetchFn.mock.calls.every(
        ([, options]) => options?.signal instanceof AbortSignal,
      ),
    ).toBe(true);
  });

  it("treats cursors as opaque query values", async () => {
    const cursor = "opaque+/=&? value";
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(page([latestReset], cursor)))
      .mockResolvedValueOnce(Response.json(page([observedReset])));
    await fetchResetHistory(undefined, fetchFn);
    const url = new URL(String(fetchFn.mock.calls[1]?.[0]));
    expect(url.searchParams.get("cursor")).toBe(cursor);
    expect([...url.searchParams.keys()]).toEqual(["limit", "cursor"]);
  });

  it.each([
    new Response(null, { status: 503 }),
    new Response("invalid JSON"),
    Response.json(page([{ ...observedReset, announced_at: "invalid" }])),
    Response.json({
      data: [observedReset],
      pagination: { has_more: true, next_cursor: null },
    }),
    new Response(null, { status: 304 }),
  ])("keeps valid pages when a later page fails: %#", async (response) => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(page([latestReset], "next-page")))
      .mockResolvedValueOnce(response);
    expect(await fetchResetHistory(undefined, fetchFn)).toMatchObject({
      kind: "ok",
      etag: null,
      data: {
        resets: [latestReset],
        firstPage: [latestReset],
        complete: false,
        failure: { kind: "error" },
      },
    });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["120", 120],
    [null, 60],
    ["Mon, 02 Nov 2026 12:02:00 GMT", 120],
  ] as const)(
    "preserves a later 429 Retry-After %j and stops immediately",
    async (header, seconds) => {
      vi.spyOn(Date, "now").mockReturnValue(
        Date.parse("2026-11-02T12:00:00.000Z"),
      );
      const fetchFn = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json(page([latestReset], "next-page")))
        .mockResolvedValueOnce(
          new Response(null, {
            status: 429,
            headers: header === null ? {} : { "Retry-After": header },
          }),
        );
      expect(await fetchResetHistory(undefined, fetchFn)).toEqual({
        kind: "ok",
        etag: null,
        data: {
          resets: [latestReset],
          firstPage: [latestReset],
          complete: false,
          failure: { kind: "rate-limited", retryAfterSeconds: seconds },
        },
      });
      expect(fetchFn).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    new TypeError("Offline"),
    new DOMException("Timed out", "TimeoutError"),
  ])(
    "keeps valid pages after a network error or timeout: %s",
    async (error) => {
      const fetchFn = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json(page([latestReset], "next-page")))
        .mockRejectedValueOnce(error);
      expect(await fetchResetHistory(undefined, fetchFn)).toMatchObject({
        kind: "ok",
        data: {
          resets: [latestReset],
          complete: false,
          failure: { kind: "error", message: error.message },
        },
      });
      expect(fetchFn).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    {},
    { data: [latestReset] },
    { data: [null], pagination: { has_more: false, next_cursor: null } },
    { data: [], pagination: { has_more: "yes", next_cursor: "next" } },
    { data: [], pagination: { has_more: true, next_cursor: "" } },
    { data: [], pagination: { has_more: true, next_cursor: null } },
    { data: [], pagination: { has_more: false, next_cursor: 123 } },
  ])("validates the first page and pagination: %j", async (body) => {
    const fetchFn = fakeResponse(body);
    expect(await fetchResetHistory(undefined, fetchFn)).toEqual({
      kind: "error",
      message: "Invalid API response.",
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("propagates a first-page rate limit without requesting another page", async () => {
    const fetchFn = fakeResponse(null, {
      status: 429,
      headers: { "Retry-After": "90" },
    });
    expect(await fetchResetHistory(undefined, fetchFn)).toEqual({
      kind: "rate-limited",
      retryAfterSeconds: 90,
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it.each([
    [2, 2],
    [0, 1],
    [-1, 1],
    [1.8, 1],
    [Infinity, HISTORY_MAX_PAGES],
    [NaN, HISTORY_MAX_PAGES],
    [100, HISTORY_MAX_PAGES],
  ])("bounds maxPages %s to %s requests", async (maxPages, expected) => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockImplementation(async () =>
        Response.json(page([], `cursor-${fetchFn.mock.calls.length}`)),
      );
    expect(await fetchResetHistory(maxPages, fetchFn)).toMatchObject({
      kind: "ok",
      data: {
        complete: false,
        failure: {
          kind: "error",
          message: "Reset history reached the page limit.",
        },
      },
    });
    expect(fetchFn).toHaveBeenCalledTimes(expected);
  });

  it("keeps all pages when stopping at the page limit", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(page([latestReset], "next-1")))
      .mockResolvedValueOnce(Response.json(page([observedReset], "next-2")));
    expect(await fetchResetHistory(2, fetchFn)).toMatchObject({
      kind: "ok",
      data: {
        resets: [latestReset, observedReset],
        firstPage: [latestReset],
        complete: false,
      },
    });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("marks the final allowed page complete when there is no next page", async () => {
    const fetchFn = fakeResponse(page([latestReset]));
    expect(await fetchResetHistory(1, fetchFn)).toMatchObject({
      kind: "ok",
      data: { complete: true, failure: null },
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a", "a"],
    ["a", "b", "a"],
  ])("stops repeated cursor cycles: %j", async (...cursors: string[]) => {
    const fetchFn = vi.fn<typeof fetch>();
    for (const cursor of cursors)
      fetchFn.mockResolvedValueOnce(Response.json(page([latestReset], cursor)));
    expect(await fetchResetHistory(undefined, fetchFn)).toMatchObject({
      kind: "ok",
      data: {
        complete: false,
        failure: { kind: "error", message: "Reset history cursor repeated." },
      },
    });
    expect(fetchFn).toHaveBeenCalledTimes(cursors.length);
  });
});
