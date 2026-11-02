import { describe, expect, it } from "vitest";
import { parsePushPayload, sanitizeUrl } from "./payload";

const resetDefaults = {
  kind: "reset",
  title: "✅ Codex reset confirmed",
  body: "A Codex usage-limit reset was confirmed.",
  url: "https://codex-resets.com/",
};

const watchDefaults = {
  kind: "watch",
  title: "⚠️ Possible Codex reset",
  body: "Prediction, not a confirmed reset.",
  url: "https://codex-resets.com/",
};

describe("parsePushPayload", () => {
  it("returns reset defaults for null", () => {
    expect(parsePushPayload(null)).toEqual(resetDefaults);
  });

  it("keeps watch kind and its defaults", () => {
    expect(parsePushPayload('{"kind":"watch"}')).toEqual(watchDefaults);
  });

  it.each([undefined, "unknown", "WATCH", "regular", null, 1, {}])(
    "treats any unknown kind as reset: %j",
    (kind) => {
      expect(parsePushPayload(JSON.stringify({ kind }))).toEqual(resetDefaults);
    },
  );

  it("falls back to defaults on invalid JSON", () => {
    expect(parsePushPayload("{invalid")).toEqual(resetDefaults);
  });

  it.each(["javascript:alert(1)", "http://example.com", "data:text/html,x"])(
    "replaces a non-https url with the site url: %j",
    (url) => {
      expect(parsePushPayload(JSON.stringify({ url }))).toEqual(resetDefaults);
    },
  );

  it.each([
    "https://example.com/announcement?id=1#reset",
    "HTTPS://EXAMPLE.COM/x",
  ])("keeps an https url: %j", (url) => {
    expect(parsePushPayload(JSON.stringify({ url }))).toEqual({
      ...resetDefaults,
      url,
    });
  });

  it.each(["null", "true", "42", '"watch"', "[]"])(
    "returns reset defaults for a non-object JSON value: %j",
    (raw) => {
      expect(parsePushPayload(raw)).toEqual(resetDefaults);
    },
  );

  it.each(["watch", "reset"])(
    "preserves a custom title and body: %j",
    (kind) => {
      const payload = {
        kind,
        title: "Custom alert",
        body: "Custom details.",
        url: "https://codex-resets.com/announcement",
      };
      expect(parsePushPayload(JSON.stringify(payload))).toEqual(payload);
    },
  );

  it.each(
    ["watch", "reset"].flatMap((kind) =>
      [null, false, 42, {}, [], ""].map((value) => ({ kind, value })),
    ),
  )(
    "uses kind-specific defaults for non-string or empty text fields: %j",
    ({ kind, value }) => {
      expect(
        parsePushPayload(JSON.stringify({ kind, title: value, body: value })),
      ).toEqual(kind === "watch" ? watchDefaults : resetDefaults);
    },
  );

  it.each(
    [
      null,
      false,
      42,
      {},
      [],
      ["https://example.com/"],
      "",
      "/announcement",
      "//example.com/x",
      "https://",
    ].map((url) => ({ url })),
  )(
    "uses the site url for missing, non-string or invalid URLs: %j",
    ({ url }) => {
      expect(parsePushPayload(JSON.stringify({ url }))).toEqual(resetDefaults);
    },
  );
});

describe("sanitizeUrl", () => {
  it.each(["https://example.com/", "HTTPS://EXAMPLE.COM/x"])(
    "preserves an https string verbatim: %j",
    (url) => {
      expect(sanitizeUrl(url)).toBe(url);
    },
  );

  it.each(
    [
      ["https://example.com/"],
      "//example.com/x",
      "javascript:alert(1)",
      "http://x",
      "",
      null,
    ].map((value) => ({ value })),
  )("uses the site url for an unsafe or non-string value: %j", ({ value }) => {
    expect(sanitizeUrl(value)).toBe("https://codex-resets.com/");
  });
});
