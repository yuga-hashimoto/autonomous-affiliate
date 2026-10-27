import { execFile } from "node:child_process";
import { access, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import { LivePublisherIO } from "../../apps/worker/src/live-io.js";

const execFileAsync = promisify(execFile);

const TMP = path.resolve(__dirname, "../../.tmp/live-io-image-test");
const CONTENT_DIR = path.join(TMP, "content/articles");
const HERO = "apps/site/public/images/articles/article-a/hero.webp";
const BYTES = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 9, 8, 7]);

async function git(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: TMP });
  return stdout.trim();
}

async function exists(file: string): Promise<boolean> {
  return access(file).then(
    () => true,
    () => false,
  );
}

function io(): LivePublisherIO {
  return new LivePublisherIO({ repoRoot: TMP, contentDir: CONTENT_DIR, buildSite: async () => undefined });
}

describe("LivePublisherIO hero images", () => {
  beforeAll(async () => {
    await rm(TMP, { recursive: true, force: true });
    await mkdir(CONTENT_DIR, { recursive: true });
    await git("init");
    await git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "init");
  }, 30000);

  it("commits the image together with the article in one commit", async () => {
    const site = io();
    await site.writeArtifact("content/articles/article-a.ja-JP.md", "# hello");
    await site.writeBinary(HERO, BYTES);

    const sha = await site.commitArtifact("content/articles/article-a.ja-JP.md", "publish: article-a", [HERO]);

    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(new Uint8Array(await readFile(path.join(TMP, HERO)))).toEqual(BYTES);
    const files = (await git("show", "--name-only", "--format=", "HEAD")).split("\n").sort();
    expect(files).toEqual([HERO, "content/articles/article-a.ja-JP.md"].sort());
  });

  it("removes an image it wrote", async () => {
    const site = io();
    const other = "apps/site/public/images/articles/article-b/hero.webp";
    await site.writeBinary(other, BYTES);
    expect(await exists(path.join(TMP, other))).toBe(true);

    await site.removeBinary(other);

    expect(await exists(path.join(TMP, other))).toBe(false);
  });

  it.each([
    "../outside.webp",
    "apps/site/public/images/../../../outside.webp",
    "apps/site/public/other/hero.webp",
    "content/articles/x.md",
    "/etc/passwd",
  ])("refuses to write or remove %s", async (target) => {
    const site = io();

    await expect(site.writeBinary(target, BYTES)).rejects.toThrow(/escapes/);
    await expect(site.removeBinary(target)).rejects.toThrow(/escapes/);
  });

  it("refuses to commit an extra path outside the images folder", async () => {
    const site = io();
    await site.writeArtifact("content/articles/article-c.ja-JP.md", "# c");
    const before = await git("rev-parse", "HEAD");

    await expect(
      site.commitArtifact("content/articles/article-c.ja-JP.md", "publish: article-c", ["package.json"]),
    ).rejects.toThrow(/escapes/);

    expect(await git("rev-parse", "HEAD")).toBe(before);
  });
});
