export interface FetchResult {
  status: number;
  body: string;
  contentType: string;
  finalUrl: string;
}

/** Pluggable HTTP access so tests and dry-runs never touch the network. */
export interface Fetcher {
  fetch(url: string, options?: { timeoutMs?: number; maxBytes?: number }): Promise<FetchResult>;
}

export class FetchError extends Error {
  constructor(
    public readonly url: string,
    public readonly status: number | null,
    detail: string,
  ) {
    super(`fetch failed for ${url}: ${detail}`);
    this.name = "FetchError";
  }
}

const USER_AGENT = "autonomous-affiliate-research/0.1 (+dry-run; respects robots and ToS)";

export class HttpFetcher implements Fetcher {
  async fetch(url: string, options?: { timeoutMs?: number; maxBytes?: number }): Promise<FetchResult> {
    const timeoutMs = options?.timeoutMs ?? 15000;
    const maxBytes = options?.maxBytes ?? 2_000_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await globalThis.fetch(url, {
        redirect: "follow",
        signal: controller.signal,
        headers: { "user-agent": USER_AGENT, accept: "text/html,application/json;q=0.9,*/*;q=0.5" },
      });
      const contentType = response.headers.get("content-type") ?? "application/octet-stream";
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > maxBytes) {
        throw new FetchError(url, response.status, `body exceeds ${maxBytes} bytes`);
      }
      return {
        status: response.status,
        body: new TextDecoder().decode(buffer),
        contentType,
        finalUrl: response.url || url,
      };
    } catch (error) {
      if (error instanceof FetchError) throw error;
      throw new FetchError(url, null, String(error));
    } finally {
      clearTimeout(timer);
    }
  }
}

/** In-memory fetcher backed by a URL -> body map; used by fixtures and tests. */
export class MapFetcher implements Fetcher {
  constructor(
    private readonly responses: Map<string, { body: string; contentType?: string; status?: number }>,
  ) {}

  async fetch(url: string): Promise<FetchResult> {
    const entry = this.responses.get(url);
    if (!entry) {
      throw new FetchError(url, 404, "no fixture registered for this URL");
    }
    return {
      status: entry.status ?? 200,
      body: entry.body,
      contentType: entry.contentType ?? "text/html; charset=utf-8",
      finalUrl: url,
    };
  }
}
