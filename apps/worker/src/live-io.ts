import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { PublisherIO } from "@aff/agents";

const execFileAsync = promisify(execFile);

export interface LiveIoOptions {
  /** Absolute path to the git repository root. */
  repoRoot: string;
  /** Absolute path to the article store (e.g. <root>/content/articles). */
  contentDir: string;
  /** Command runner; injectable for tests. */
  run?: (
    cmd: string,
    args: string[],
    cwd: string,
  ) => Promise<{ stdout: string; stderr: string }>;
  /** Static site build; injectable for tests (defaults to `pnpm --filter site build`). */
  buildSite?: () => Promise<void>;
}

function sanitizeRelPath(path: string): string {
  const abs = resolve(path);
  return abs;
}

/**
 * Live publish path: writes the QA'd artifact into the versioned article
 * store, rebuilds the static site (failure => nothing is committed, previous
 * version stays live), then records a git commit for auditability/rollback.
 * Deploy itself is handled by CI from the committed state.
 */
export class LivePublisherIO implements PublisherIO {
  private readonly run: NonNullable<LiveIoOptions["run"]>;

  constructor(private readonly options: LiveIoOptions) {
    this.run =
      options.run ??
      (async (cmd, args, cwd) => execFileAsync(cmd, args, { cwd, maxBuffer: 32 * 1024 * 1024 }));
  }

  async writeArtifact(path: string, content: string): Promise<void> {
    // The publisher passes "<siteContentDir>/<file>"; resolve inside contentDir.
    const base = sanitizeRelPath(this.options.contentDir);
    const target = join(base, path.replace(/^content\/articles\//, ""));
    if (!resolve(target).startsWith(base)) {
      throw new Error(`artifact path escapes content dir: ${path}`);
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }

  async buildSite(): Promise<void> {
    if (this.options.buildSite) {
      await this.options.buildSite();
      return;
    }
    await this.run("pnpm", ["--filter", "site", "build"], this.options.repoRoot);
  }

  async commitArtifact(path: string, message: string): Promise<string> {
    const rel = path.replace(/^content\/articles\//, "");
    const cwd = this.options.repoRoot;
    await this.run("git", ["add", join("content/articles", rel)], cwd);
    const commit = await this.run(
      "git",
      ["-c", "user.name=autonomous-affiliate", "-c", "user.email=aff-bot@users.noreply.local", "commit", "-m", message],
      cwd,
    ).catch((error: unknown) => {
      const err = error as { stdout?: string; stderr?: string };
      const output = `${err.stdout ?? ""}${err.stderr ?? ""}`;
      if (output.includes("nothing to commit")) return { stdout: "", stderr: "" };
      throw error;
    });
    const sha = await this.run("git", ["rev-parse", "HEAD"], cwd);
    void commit;
    return sha.stdout.trim();
  }
}
