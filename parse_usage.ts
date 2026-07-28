/**
 * parse_usage.ts — robust OpenCode Go usage parser
 *
 * Extracts rolling/weekly/monthly usage from SolidJS hydration data
 * embedded in opencode.ai SSR HTML pages.
 */

export interface OCUsageWindow {
  status: string;
  resetInSec: number;
  usagePercent: number;
}

export interface OCUsageResponse {
  rollingUsage: OCUsageWindow;
  weeklyUsage: OCUsageWindow;
  monthlyUsage: OCUsageWindow;
}

/** Extract a single usage window from html using the given key name. */
function extractWindow(html: string, key: string): OCUsageWindow {
  // Step 1: capture the object literal body belonging to this key.
  // Pattern: keyName followed by any non-brace chars, then { … }
  const bodyRe = new RegExp(`${key}[^{]*\\{([^}]+)\\}`, "s");
  const bodyMatch = html.match(bodyRe);
  const body = bodyMatch ? bodyMatch[1] : "";

  // Step 2: extract values from the object body (scoped, won't leak).
  const pctMatch = body.match(/usagePercent:(\d+)/);
  const resetMatch = body.match(/resetInSec:(\d+)/);

  return {
    status: "ok",
    usagePercent: pctMatch ? parseInt(pctMatch[1]) : 0,
    resetInSec: resetMatch ? parseInt(resetMatch[1]) : 0,
  };
}

/**
 * Parse OpenCode Go usage from an SSR HTML page.
 * Returns an object with rollingUsage, weeklyUsage, monthlyUsage.
 * Missing / unparseable fields fall back to 0.
 */
export function parseOpenCodeUsage(html: string): OCUsageResponse {
  // Sanity check — the page must at least mention the subscription data
  if (!html.includes("lite.subscription.get")) {
    throw new Error(
      "no Go subscription found" +
        " — visit opencode.ai/go to subscribe first",
    );
  }

  return {
    rollingUsage: extractWindow(html, "rollingUsage"),
    weeklyUsage: extractWindow(html, "weeklyUsage"),
    monthlyUsage: extractWindow(html, "monthlyUsage"),
  };
}
