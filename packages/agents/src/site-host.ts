/** Names of sites: the host a program points at, reduced to the site's own name. */

const TWO_PART_SUFFIXES = new Set(["co.jp", "or.jp", "ne.jp", "ac.jp", "go.jp", "ed.jp", "gr.jp", "ad.jp", "lg.jp", "com.au", "co.uk"]);
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const SLUG_MAX = 32;

/** The site's own name: the host without `www.` and subdomains. Nothing for an IP address or a single-label name. */
export function registrableHost(host: string): string | undefined {
  const labels = host.trim().toLowerCase().replace(/\.$/, "").split(".");
  if (labels.length < 2 || !labels.every((label) => HOST_LABEL.test(label))) return undefined;
  if (labels.every((label) => /^\d+$/.test(label))) return undefined;
  const lastTwo = labels.slice(-2).join(".");
  const take = TWO_PART_SUFFIXES.has(lastTwo) ? 3 : 2;
  return labels.slice(-take).join(".");
}

/** A short ascii slug from the site's name (`cosmo-water.com` -> `cosmo-water`). */
export function slugForHost(registrable: string): string | undefined {
  const labels = registrable.split(".");
  const take = TWO_PART_SUFFIXES.has(labels.slice(-2).join(".")) ? 2 : 1;
  const name = labels.slice(0, labels.length - take).at(-1);
  if (!name || name.startsWith("xn--") || name.length > SLUG_MAX) return undefined;
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) ? name : undefined;
}
