import type { A8ProgramsConfig } from "@aff/agents";
import { openAdUrlManager, submitUrlsInPage } from "./a8-adurl.js";
import { publicErrorLine, withA8Session, type A8SmokeResult } from "./a8-login.js";
import { readListPage } from "./a8-programs.js";
import { collectAdPages } from "./ad-pages.js";

/**
 * Registers the article pages that carry a brand's ad with that brand's program in the A8 console
 * (広告掲載URL管理), after the site is deployed (docs/20). The pages come from the built site: the
 * article pages that link to the brand's `/go/` offers, by their canonical URLs. Submitting a URL again
 * only renews its date, so every run submits all of them. The log is public: counts only.
 */

export interface SubmitReport {
  outcome: "ok" | "login_failed" | "nothing_to_submit";
  login?: A8SmokeResult;
  brands: number;
  pages: number;
  /** Brands by what happened: all_verified, partly_verified, no_manager_window, failed. */
  results?: Record<string, number>;
  submitted?: number;
  /** URLs the program's own list showed after the submission. */
  verified?: number;
  /** Plain error lines of brands that failed (secrets and numbers masked). */
  errors?: string[];
}

const MAX_ERRORS = 3;

const tally = (labels: readonly string[]): Record<string, number> =>
  labels.reduce<Record<string, number>>((counts, label) => ({ ...counts, [label]: (counts[label] ?? 0) + 1 }), {});

export async function runA8SubmitUrls(env: NodeJS.ProcessEnv, deps: { config: A8ProgramsConfig; distDir: string }): Promise<SubmitReport> {
  const { config, distDir } = deps;
  const pagesByBrand = await collectAdPages(distDir, config.brands);
  const targets = config.brands.filter((brand) => (pagesByBrand[brand.brandSlug] ?? []).length > 0);
  const pages = targets.reduce((sum, brand) => sum + (pagesByBrand[brand.brandSlug]?.length ?? 0), 0);
  if (targets.length === 0) return { outcome: "nothing_to_submit", brands: 0, pages: 0 };

  const { login, value } = await withA8Session(env, async (page) => {
    const labels: string[] = [];
    const errors = new Set<string>();
    let submitted = 0;
    let verified = 0;
    for (const brand of targets) {
      await readListPage(page, "partnered", 1);
      const manager = await openAdUrlManager(page, brand.keyword);
      if (!manager) {
        labels.push("no_manager_window");
        continue;
      }
      try {
        const result = await submitUrlsInPage(manager, pagesByBrand[brand.brandSlug]!);
        submitted += result.submitted;
        verified += result.verified;
        labels.push(result.verified === result.submitted ? "all_verified" : "partly_verified");
      } catch (error) {
        labels.push("failed");
        errors.add(publicErrorLine(error instanceof Error ? error.message : String(error), []));
      } finally {
        await manager.close().catch(() => undefined);
      }
    }
    return { labels, errors: [...errors].slice(0, MAX_ERRORS), submitted, verified };
  });
  if (!value) return { outcome: "login_failed", login, brands: targets.length, pages };
  return {
    outcome: "ok",
    brands: targets.length,
    pages,
    results: tally(value.labels),
    submitted: value.submitted,
    verified: value.verified,
    ...(value.errors.length > 0 ? { errors: value.errors } : {}),
  };
}
