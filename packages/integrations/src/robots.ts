import type { Fetcher } from "./fetcher.js";

export interface RobotsReport {
  url: string;
  available: boolean;
  /** Rules for User-agent: * (empty when no specific group exists). */
  starRules: { allows: string[]; disallows: string[]; crawlDelaySeconds?: number };
  /** True when the target path is disallowed for *. */
  disallowsAll: boolean;
  raw: string;
  checkedAt: string;
}

function parseRobots(raw: string): RobotsReport["starRules"] {
  const lines = raw.split(/\r?\n/).map((l) => l.trim());
  const rules: { allows: string[]; disallows: string[]; crawlDelaySeconds?: number } = {
    allows: [],
    disallows: [],
  };
  let inStarGroup = false;
  let sawAnyAgent = false;
  for (const line of lines) {
    if (line.startsWith("#") || line === "") continue;
    const [rawKey, ...rest] = line.split(":");
    const key = rawKey!.trim().toLowerCase();
    const value = rest.join(":").trim();
    if (key === "user-agent") {
      sawAnyAgent = true;
      inStarGroup = value === "*";
      continue;
    }
    if (!inStarGroup) continue;
    if (key === "allow" && value) rules.allows.push(value);
    if (key === "disallow" && value) rules.disallows.push(value);
    if (key === "crawl-delay" && value) {
      const parsed = Number(value);
      if (!Number.isNaN(parsed)) rules.crawlDelaySeconds = parsed;
    }
  }
  void sawAnyAgent;
  return rules;
}

/**
 * robots.txt due-diligence for candidate source domains. Run BEFORE adding a
 * domain to policy.security.allowed_source_domains; a domain that disallows
 * the relevant paths must not be collected (docs: robots/ToS compliance).
 */
export async function checkRobots(fetcher: Fetcher, pageUrl: string): Promise<RobotsReport> {
  const url = new URL(pageUrl);
  const robotsUrl = `${url.protocol}//${url.host}/robots.txt`;
  const checkedAt = new Date().toISOString();
  let raw = "";
  let available = false;
  try {
    const result = await fetcher.fetch(robotsUrl, { timeoutMs: 10000 });
    available = result.status >= 200 && result.status < 300;
    raw = result.body;
  } catch {
    available = false;
  }
  if (!available) {
    // No robots.txt means crawling is allowed by convention, but the operator
    // still confirms ToS before allowlisting.
    return {
      url: robotsUrl,
      available,
      starRules: { allows: [], disallows: [] },
      disallowsAll: false,
      raw,
      checkedAt,
    };
  }
  const starRules = parseRobots(raw);
  const path = url.pathname || "/";
  const disallowsAll =
    starRules.disallows.some((rule) => rule === "/" ) ||
    starRules.disallows.some((rule) => rule.length > 1 && path.startsWith(rule));
  const allowedByRule = starRules.allows.some((rule) => path.startsWith(rule));
  return {
    url: robotsUrl,
    available,
    starRules,
    disallowsAll: disallowsAll && !allowedByRule,
    raw,
    checkedAt,
  };
}
