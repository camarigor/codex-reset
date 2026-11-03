// Model of the reset history heatmap in the popup, kept free of the DOM so it
// can be tested. It follows the codex-resets.com graph: one column per week
// and one row per weekday, Sunday first, from the week of the oldest reset to
// the current week. Unlike the site, days follow the local time zone.

import type { Reset } from "../api/client";
import { sanitizeUrl } from "../push/payload";
import { t } from "./i18n";

/**
 * What a day shows: the type of its resets (a day with both types counts as
 * regular), no reset, or a day after today.
 */
export type HeatmapKind = "regular" | "banked" | "none" | "future";

export interface HeatmapDay {
  /** The calendar date in the time zone of the heatmap, as YYYY-MM-DD. */
  date: string;
  kind: HeatmapKind;
  /** The resets announced that day, newest first. Future days have none. */
  resets: Reset[];
  /**
   * The announcement of the newest reset of the day that links to one,
   * through sanitizeUrl, or null when none does.
   */
  link: string | null;
}

/** Seven days, Sunday first. */
export type HeatmapWeek = HeatmapDay[];

export interface HeatmapMonth {
  /** The short month name, such as "Nov". */
  label: string;
  /** The first week whose Sunday falls in the month. */
  weekIndex: number;
}

export interface Heatmap {
  weeks: HeatmapWeek[];
  months: HeatmapMonth[];
}

export interface HeatmapDayText {
  /** The date, such as "Nov 1, 2026". */
  date: string;
  /** What happened that day, such as "2 banked resets". */
  summary: string;
  /** Both in one line, for screen readers. */
  label: string;
}

// Dates follow the language of the UI strings, which ship in English only.
const DATE_LOCALE = "en";
const DAY_MS = 24 * 60 * 60 * 1000;

// A calendar date is a day number (days since 1970-01-01) at midnight UTC.
// UTC days all have 24 hours, so daylight saving time in the local time zone
// cannot skip or repeat a day of the grid.
const MONTH_FORMAT = new Intl.DateTimeFormat(DATE_LOCALE, {
  month: "short",
  timeZone: "UTC",
});
const DAY_FORMAT = new Intl.DateTimeFormat(DATE_LOCALE, {
  dateStyle: "medium",
  timeZone: "UTC",
});
const WEEKDAY_FORMAT = new Intl.DateTimeFormat(DATE_LOCALE, {
  weekday: "short",
  timeZone: "UTC",
});
// 2026-01-04 is a Sunday.
const A_SUNDAY = Date.UTC(2026, 0, 4) / DAY_MS;

/** Row labels, Sunday first: only Mon, Wed and Fri, as on the site. */
export const WEEKDAY_LABELS: readonly string[] = Array.from(
  { length: 7 },
  (_, weekday) =>
    weekday % 2 === 1
      ? WEEKDAY_FORMAT.format((A_SUNDAY + weekday) * DAY_MS)
      : "",
);

/** The day number of the calendar date of `time` in the time zone of `format`. */
function calendarDay(time: number, format: Intl.DateTimeFormat): number {
  const parts = format.formatToParts(time);
  const value = (type: "year" | "month" | "day"): number =>
    Number(parts.find((part) => part.type === type)?.value);
  // setUTCFullYear, unlike Date.UTC, does not read years 0 to 99 as 19xx.
  const date = new Date(0);
  date.setUTCFullYear(value("year"), value("month") - 1, value("day"));
  return date.getTime() / DAY_MS;
}

function dateKey(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

function weekday(day: number): number {
  return new Date(day * DAY_MS).getUTCDay();
}

function buildDay(
  day: number,
  today: number,
  resetsByDay: ReadonlyMap<number, Reset[]>,
): HeatmapDay {
  const date = dateKey(day);
  if (day > today) return { date, kind: "future", resets: [], link: null };

  const resets = [...(resetsByDay.get(day) ?? [])].sort(
    (a, b) => Date.parse(b.announced_at) - Date.parse(a.announced_at),
  );
  const linked = resets.find((reset) => reset.source.url !== undefined);
  return {
    date,
    kind:
      resets.length === 0
        ? "none"
        : resets.some((reset) => reset.reset_type === "regular")
          ? "regular"
          : "banked",
    resets,
    link: linked === undefined ? null : sanitizeUrl(linked.source.url),
  };
}

/**
 * Labels each month at the first week whose Sunday falls in it. A label needs
 * two weeks of room, so one followed by the next label a week later is
 * dropped; only the first label can be that short, as every other month has
 * at least four Sundays. The last label stays even when its month began this
 * week, since no label follows it.
 */
function monthLabels(weekStarts: readonly number[]): HeatmapMonth[] {
  const months: { month: number; start: number; weekIndex: number }[] = [];
  weekStarts.forEach((start, weekIndex) => {
    const month = new Date(start * DAY_MS).getUTCMonth();
    if (month !== months.at(-1)?.month) {
      months.push({ month, start, weekIndex });
    }
  });
  return months
    .filter(({ weekIndex }, index) => {
      const next = months[index + 1];
      return next === undefined || next.weekIndex - weekIndex > 1;
    })
    .map(({ start, weekIndex }) => ({
      label: MONTH_FORMAT.format(start * DAY_MS),
      weekIndex,
    }));
}

/**
 * Arranges resets by calendar day in `timeZone` (the system time zone by
 * default), from the week of the oldest reset to the week of `now`. Days
 * after the date of `now` are future days; a reset dated on one, which only
 * a clock behind the API produces, is not shown. Resets with an unparsable
 * time are ignored. An invalid `now` gives an empty heatmap.
 */
export function buildHeatmap(
  resets: readonly Reset[],
  now: Date,
  timeZone?: string,
): Heatmap {
  if (Number.isNaN(now.getTime())) return { weeks: [], months: [] };

  // Only its numbers are read: en-US gives Gregorian dates in Latin digits.
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  });
  const today = calendarDay(now.getTime(), format);
  let first = today;
  const resetsByDay = new Map<number, Reset[]>();
  for (const reset of resets) {
    const time = Date.parse(reset.announced_at);
    if (Number.isNaN(time)) continue;
    const day = calendarDay(time, format);
    first = Math.min(first, day);
    const sameDay = resetsByDay.get(day);
    if (sameDay === undefined) resetsByDay.set(day, [reset]);
    else sameDay.push(reset);
  }

  const weekStarts: number[] = [];
  for (let start = first - weekday(first); start <= today; start += 7) {
    weekStarts.push(start);
  }
  return {
    weeks: weekStarts.map((start) =>
      Array.from({ length: 7 }, (_, offset) =>
        buildDay(start + offset, today, resetsByDay),
      ),
    ),
    months: monthLabels(weekStarts),
  };
}

function summarize(resets: readonly Reset[]): string {
  const count = resets.length;
  if (count === 0) return t("historyDayNone");
  const banked = resets.filter((reset) => reset.reset_type === "banked").length;
  if (banked > 0 && banked < count) {
    return t("historyDayMixed", [String(count)]);
  }
  if (count === 1) {
    return t(banked > 0 ? "historyDayBanked" : "historyDayRegular");
  }
  return t(banked > 0 ? "historyDayBankedMany" : "historyDayRegularMany", [
    String(count),
  ]);
}

/** Words a day for its tooltip and its accessible name. */
export function describeHeatmapDay(day: HeatmapDay): HeatmapDayText {
  const date = DAY_FORMAT.format(Date.parse(`${day.date}T00:00:00Z`));
  const summary = summarize(day.resets);
  return { date, summary, label: t("historyDayLabel", [date, summary]) };
}
