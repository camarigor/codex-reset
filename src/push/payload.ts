import { SITE_ORIGIN } from "../config";

export type AlertKind = "watch" | "reset";

export interface AlertPayload {
  kind: AlertKind;
  title: string;
  body: string;
  url: string;
}

export function sanitizeUrl(value: unknown): string {
  if (typeof value === "string") {
    try {
      if (new URL(value).protocol === "https:") {
        return value;
      }
    } catch {
      // Invalid URLs use the same fallback as missing or unsafe URLs.
    }
  }
  return `${SITE_ORIGIN}/`;
}

export function parsePushPayload(raw: string | null): AlertPayload {
  let payload: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(raw ?? "{}");
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      payload = parsed as Record<string, unknown>;
    }
  } catch {
    // Malformed messages still produce a notification with the site's defaults.
  }

  const kind = payload.kind === "watch" ? "watch" : "reset";
  const defaultTitle =
    kind === "watch" ? "⚠️ Possible Codex reset" : "✅ Codex reset confirmed";
  const defaultBody =
    kind === "watch"
      ? "Prediction, not a confirmed reset."
      : "A Codex usage-limit reset was confirmed.";

  return {
    kind,
    title:
      typeof payload.title === "string" && payload.title
        ? payload.title
        : defaultTitle,
    body:
      typeof payload.body === "string" && payload.body
        ? payload.body
        : defaultBody,
    url: sanitizeUrl(payload.url),
  };
}
