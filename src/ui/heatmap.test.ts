import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import type { Reset, ResetSource, ResetType } from "../api/client";
import { SITE_ORIGIN } from "../config";
import {
  buildHeatmap,
  describeHeatmapDay,
  WEEKDAY_LABELS,
  type Heatmap,
  type HeatmapDay,
} from "./heatmap";

interface LocaleMessage {
  message: string;
  placeholders?: Record<string, { content: string }>;
}

const MESSAGES = JSON.parse(
  readFileSync(
    new URL("../../public/_locales/en/messages.json", import.meta.url),
    "utf8",
  ),
) as Record<string, LocaleMessage>;

// Resolves messages like chrome.i18n.getMessage, so tests read the shipped English.
function getMessage(
  name: string,
  substitutions?: string | (string | number)[],
): string {
  const entry = MESSAGES[name];
  if (!entry) return "";
  const values = substitutions === undefined ? [] : [substitutions].flat();
  return entry.message.replace(/\$(\w+)\$/g, (_, placeholder: string) =>
    (entry.placeholders?.[placeholder.toLowerCase()]?.content ?? "").replace(
      /\$([1-9])/g,
      (_match, index: string) => String(values[Number(index) - 1] ?? ""),
    ),
  );
}

beforeEach(() => {
  vi.spyOn(fakeBrowser.i18n, "getMessage").mockImplementation(getMessage);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const DAY_MS = 24 * 60 * 60 * 1000;
// A Monday.
const NOW = new Date("2026-11-02T15:00:00.000Z");

function reset(
  announcedAt: string,
  type: ResetType = "regular",
  source: ResetSource = {
    type: "x_post",
    author: "thsottiaux",
    url: `https://x.com/thsottiaux/status/${announcedAt}`,
  },
): Reset {
  return {
    id: `${type}-${announcedAt}`,
    reset_type: type,
    announced_at: announcedAt,
    text: "Codex usage limits have been reset.",
    source,
  };
}

function dates(days: readonly HeatmapDay[] = []): string[] {
  return days.map((day) => day.date);
}

function kinds(days: readonly HeatmapDay[] = []): string[] {
  return days.map((day) => day.kind);
}

function dayOf(heatmap: Heatmap, date: string): HeatmapDay {
  const day = heatmap.weeks.flat().find((entry) => entry.date === date);
  if (day === undefined) throw new Error(`${date} is not in the heatmap`);
  return day;
}

describe("buildHeatmap", () => {
  it("groups resets into days of Sunday-first weeks, from the week of the oldest reset to the current week", () => {
    const wednesday = reset("2026-10-28T06:29:38.000Z");
    const heatmap = buildHeatmap([wednesday], NOW, "UTC");

    expect(heatmap.weeks).toHaveLength(2);
    expect(dates(heatmap.weeks[0])).toEqual([
      "2026-10-25",
      "2026-10-26",
      "2026-10-27",
      "2026-10-28",
      "2026-10-29",
      "2026-10-30",
      "2026-10-31",
    ]);
    expect(kinds(heatmap.weeks[0])).toEqual([
      "none",
      "none",
      "none",
      "regular",
      "none",
      "none",
      "none",
    ]);
    expect(heatmap.weeks[0]?.[3]?.resets).toEqual([wednesday]);
    expect(dates(heatmap.weeks[1])).toEqual([
      "2026-11-01",
      "2026-11-02",
      "2026-11-03",
      "2026-11-04",
      "2026-11-05",
      "2026-11-06",
      "2026-11-07",
    ]);
  });

  it("starts at the week of the oldest reset whatever the order of the resets", () => {
    const resets = [
      reset("2026-10-28T06:29:38.000Z"),
      reset("2026-10-01T12:00:00.000Z", "banked"),
      reset("2026-10-15T12:00:00.000Z"),
    ];

    const heatmap = buildHeatmap(resets, NOW, "UTC");

    expect(heatmap).toEqual(buildHeatmap([...resets].reverse(), NOW, "UTC"));
    expect(heatmap.weeks).toHaveLength(6);
    // October 1 is a Thursday: its week starts on Sunday, September 27.
    expect(dates(heatmap.weeks[0])[0]).toBe("2026-09-27");
    expect(kinds(heatmap.weeks[0])).toEqual([
      "none",
      "none",
      "none",
      "none",
      "banked",
      "none",
      "none",
    ]);
  });

  it("puts every reset of a day on that day, newest first", () => {
    const morning = reset("2026-10-25T03:06:00.000Z");
    const evening = reset("2026-10-25T20:00:00.000Z");

    const day = dayOf(
      buildHeatmap([morning, evening], NOW, "UTC"),
      "2026-10-25",
    );

    expect(day.kind).toBe("regular");
    expect(day.resets).toEqual([evening, morning]);
  });

  it("counts a day with both types as regular", () => {
    const banked = reset("2026-10-28T01:00:00.000Z", "banked");
    const regular = reset("2026-10-28T06:00:00.000Z");
    const heatmap = buildHeatmap([banked, regular], NOW, "UTC");

    expect(dayOf(heatmap, "2026-10-28")).toMatchObject({
      kind: "regular",
      resets: [regular, banked],
    });
  });

  it("marks a day with banked resets only as banked", () => {
    const heatmap = buildHeatmap(
      [
        reset("2026-11-01T00:43:20.000Z", "banked"),
        reset("2026-11-01T23:27:20.000Z", "banked"),
      ],
      NOW,
      "UTC",
    );

    expect(dayOf(heatmap, "2026-11-01").kind).toBe("banked");
    expect(dayOf(heatmap, "2026-11-01").resets).toHaveLength(2);
  });

  describe("time zone", () => {
    // The two banked resets of November 1 (UTC) on codex-resets.com.
    const first = reset("2026-11-01T00:43:20.000Z", "banked");
    const second = reset("2026-11-01T23:27:20.000Z", "banked");
    const evening = new Date("2026-11-02T21:00:00.000Z");

    it("groups resets by the calendar day in UTC", () => {
      const heatmap = buildHeatmap([first, second], evening, "UTC");

      expect(heatmap.weeks).toHaveLength(1);
      expect(heatmap.weeks[0]?.[0]).toMatchObject({
        date: "2026-11-01",
        kind: "banked",
        resets: [second, first],
      });
      expect(dayOf(heatmap, "2026-11-02").kind).toBe("none");
    });

    it("moves a reset to the previous day, and week, behind UTC", () => {
      const heatmap = buildHeatmap(
        [first, second],
        evening,
        "America/Sao_Paulo",
      );

      expect(heatmap.weeks).toHaveLength(2);
      // 2026-11-01T00:43Z is Saturday, October 31, 21:43 in São Paulo.
      expect(heatmap.weeks[0]?.[6]).toMatchObject({
        date: "2026-10-31",
        kind: "banked",
        resets: [first],
      });
      expect(heatmap.weeks[1]?.[0]).toMatchObject({
        date: "2026-11-01",
        kind: "banked",
        resets: [second],
      });
    });

    it("moves a reset to the next day ahead of UTC", () => {
      const heatmap = buildHeatmap([first, second], evening, "Asia/Tokyo");

      expect(kinds(heatmap.weeks[0])).toEqual([
        "banked",
        "banked",
        "none",
        "future",
        "future",
        "future",
        "future",
      ]);
      expect(heatmap.weeks[0]?.[0]?.resets).toEqual([first]);
      expect(heatmap.weeks[0]?.[1]?.resets).toEqual([second]);
    });

    it("takes today from the date of now in the time zone", () => {
      // 01:00 UTC on Monday is 22:00 on Sunday in São Paulo.
      const lateSunday = new Date("2026-11-02T01:00:00.000Z");

      expect(
        kinds(buildHeatmap([], lateSunday, "America/Sao_Paulo").weeks[0]),
      ).toEqual([
        "none",
        "future",
        "future",
        "future",
        "future",
        "future",
        "future",
      ]);
      expect(kinds(buildHeatmap([], lateSunday, "UTC").weeks[0])).toEqual([
        "none",
        "none",
        "future",
        "future",
        "future",
        "future",
        "future",
      ]);
    });

    it("uses the system time zone by default", () => {
      const system = Intl.DateTimeFormat().resolvedOptions().timeZone;

      expect(buildHeatmap([first, second], evening)).toEqual(
        buildHeatmap([first, second], evening, system),
      );
    });

    it("keeps one cell per calendar day across a daylight saving change", () => {
      // New York leaves daylight saving time on November 1, 2026.
      const heatmap = buildHeatmap(
        [reset("2026-10-20T12:00:00.000Z")],
        new Date("2026-11-12T12:00:00.000Z"),
        "America/New_York",
      );
      const days = dates(heatmap.weeks.flat()).map((date) => Date.parse(date));
      const steps = days
        .slice(1)
        .map((day, index) => day - (days[index] ?? Number.NaN));

      expect(heatmap.weeks).toHaveLength(4);
      expect(dates(heatmap.weeks.flat()).slice(13, 16)).toEqual([
        "2026-10-31",
        "2026-11-01",
        "2026-11-02",
      ]);
      expect(new Set(steps)).toEqual(new Set([DAY_MS]));
    });
  });

  describe("today and future days", () => {
    it("shows today as a past day and the rest of the week as future days without resets", () => {
      const today = reset("2026-11-02T09:00:00.000Z");
      const heatmap = buildHeatmap([today], NOW, "UTC");

      expect(kinds(heatmap.weeks.at(-1))).toEqual([
        "none",
        "regular",
        "future",
        "future",
        "future",
        "future",
        "future",
      ]);
      expect(
        heatmap.weeks
          .flat()
          .filter((day) => day.kind === "future")
          .every((day) => day.resets.length === 0 && day.link === null),
      ).toBe(true);
    });

    it("counts a reset later today, from a clock behind the API, on today", () => {
      const laterToday = reset("2026-11-02T22:00:00.000Z");

      expect(
        dayOf(buildHeatmap([laterToday], NOW, "UTC"), "2026-11-02"),
      ).toMatchObject({ kind: "regular", resets: [laterToday] });
    });

    it("does not show resets dated after today", () => {
      const heatmap = buildHeatmap(
        [
          reset("2026-11-03T09:00:00.000Z"),
          reset("2026-11-10T09:00:00.000Z", "banked"),
        ],
        NOW,
        "UTC",
      );

      expect(heatmap.weeks).toHaveLength(1);
      expect(dayOf(heatmap, "2026-11-03")).toMatchObject({
        kind: "future",
        resets: [],
      });
    });
  });

  it("ignores resets with an invalid timestamp", () => {
    const valid = reset("2026-10-28T06:29:38.000Z");

    expect(
      buildHeatmap([reset("not a date"), valid, reset("")], NOW, "UTC"),
    ).toEqual(buildHeatmap([valid], NOW, "UTC"));
  });

  it("shows only the current week when there is no reset", () => {
    const heatmap = buildHeatmap([], NOW, "UTC");

    expect(heatmap.weeks).toHaveLength(1);
    expect(heatmap.weeks[0]?.[1]?.date).toBe("2026-11-02");
  });

  it("gives an empty heatmap for an invalid now", () => {
    expect(
      buildHeatmap([reset("2026-10-28T06:29:38.000Z")], new Date(Number.NaN)),
    ).toEqual({ weeks: [], months: [] });
  });

  describe("links", () => {
    it("opens the announcement of the newest reset of the day that has one", () => {
      const linked = reset("2026-10-28T01:00:00.000Z", "regular", {
        type: "x_post",
        url: "https://x.com/thsottiaux/status/2115330127886463244",
      });
      const unlinked = reset("2026-10-28T09:00:00.000Z", "regular", {
        type: "observed",
      });

      expect(
        dayOf(buildHeatmap([linked, unlinked], NOW, "UTC"), "2026-10-28").link,
      ).toBe("https://x.com/thsottiaux/status/2115330127886463244");
    });

    it.each([
      ["javascript:alert(1)"],
      ["http://x.com/thsottiaux/status/1"],
      ["not a url"],
    ])("sends the unsafe link %s to the site", (url) => {
      const heatmap = buildHeatmap(
        [reset("2026-10-28T01:00:00.000Z", "regular", { type: "x_post", url })],
        NOW,
        "UTC",
      );

      expect(dayOf(heatmap, "2026-10-28").link).toBe(`${SITE_ORIGIN}/`);
    });

    it("has no link without an announcement or without a reset", () => {
      const heatmap = buildHeatmap(
        [reset("2026-10-28T01:00:00.000Z", "regular", { type: "observed" })],
        NOW,
        "UTC",
      );

      expect(dayOf(heatmap, "2026-10-28").link).toBeNull();
      expect(dayOf(heatmap, "2026-10-29").link).toBeNull();
    });
  });

  describe("month labels", () => {
    it("labels each month at the first week whose Sunday falls in it", () => {
      // September 8 is a Tuesday: the first week starts on September 6.
      const heatmap = buildHeatmap(
        [reset("2026-09-08T01:56:57.501Z")],
        NOW,
        "UTC",
      );

      expect(heatmap.weeks).toHaveLength(9);
      expect(heatmap.months).toEqual([
        { label: "Sep", weekIndex: 0 },
        { label: "Oct", weekIndex: 4 },
        { label: "Nov", weekIndex: 8 },
      ]);
    });

    it("labels the months across a new year", () => {
      const heatmap = buildHeatmap(
        [reset("2025-12-10T12:00:00.000Z")],
        new Date("2026-01-20T12:00:00.000Z"),
        "UTC",
      );

      expect(heatmap.months).toEqual([
        { label: "Dec", weekIndex: 0 },
        { label: "Jan", weekIndex: 4 },
      ]);
    });

    it("drops a first label with a single week of room", () => {
      // The first week starts on Sunday, September 27; October starts a week later.
      const heatmap = buildHeatmap(
        [reset("2026-10-01T12:00:00.000Z")],
        new Date("2026-10-20T12:00:00.000Z"),
        "UTC",
      );

      expect(heatmap.months).toEqual([{ label: "Oct", weekIndex: 1 }]);
    });

    it("keeps the last label when its month began this week", () => {
      expect(
        buildHeatmap([reset("2026-10-28T06:29:38.000Z")], NOW, "UTC").months,
      ).toEqual([{ label: "Nov", weekIndex: 1 }]);
      expect(buildHeatmap([], NOW, "UTC").months).toEqual([
        { label: "Nov", weekIndex: 0 },
      ]);
    });

    it("follows the weeks of the time zone", () => {
      // Sunday, November 1, 00:30 UTC is still Saturday, October 31, in São Paulo.
      const sundayInUtc = new Date("2026-11-01T00:30:00.000Z");

      expect(buildHeatmap([], sundayInUtc, "UTC").months).toEqual([
        { label: "Nov", weekIndex: 0 },
      ]);
      expect(buildHeatmap([], sundayInUtc, "America/Sao_Paulo").months).toEqual(
        [{ label: "Oct", weekIndex: 0 }],
      );
    });
  });
});

describe("WEEKDAY_LABELS", () => {
  it("labels Monday, Wednesday and Friday of the Sunday-first rows", () => {
    expect(WEEKDAY_LABELS).toEqual(["", "Mon", "", "Wed", "", "Fri", ""]);
  });
});

describe("describeHeatmapDay", () => {
  function day(date: string, resets: Reset[]): HeatmapDay {
    return { date, kind: "none", resets, link: null };
  }

  it.each([
    ["no reset", [], "No reset"],
    ["one regular reset", [reset("2026-11-01T12:00:00.000Z")], "Regular reset"],
    [
      "one banked reset",
      [reset("2026-11-01T12:00:00.000Z", "banked")],
      "Banked reset",
    ],
    [
      "two regular resets",
      [reset("2026-11-01T12:00:00.000Z"), reset("2026-11-01T13:00:00.000Z")],
      "2 regular resets",
    ],
    [
      "three banked resets",
      [
        reset("2026-11-01T12:00:00.000Z", "banked"),
        reset("2026-11-01T13:00:00.000Z", "banked"),
        reset("2026-11-01T14:00:00.000Z", "banked"),
      ],
      "3 banked resets",
    ],
    [
      "resets of both types",
      [
        reset("2026-11-01T12:00:00.000Z", "banked"),
        reset("2026-11-01T13:00:00.000Z"),
      ],
      "2 resets, regular and banked",
    ],
  ])("words a day with %s", (_name, resets, summary) => {
    expect(describeHeatmapDay(day("2026-11-01", resets))).toEqual({
      date: "Nov 1, 2026",
      summary,
      label: `Nov 1, 2026: ${summary}`,
    });
  });

  it("formats the date of the day key in any system time zone", () => {
    expect(describeHeatmapDay(day("2026-01-01", [])).date).toBe("Jan 1, 2026");
    expect(describeHeatmapDay(day("2025-12-31", [])).date).toBe("Dec 31, 2025");
  });
});
