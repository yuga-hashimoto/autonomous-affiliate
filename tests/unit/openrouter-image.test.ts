import { describe, expect, it } from "vitest";
import { ImageProviderError, OpenRouterImageProvider } from "@aff/integrations";

const KEY = "sk-or-test-secret-key";
const MODEL = "qwen/qwen-image-2.1-turbo";
const IMAGE_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const IMAGE_B64 = Buffer.from(IMAGE_BYTES).toString("base64");
const REQUEST = { prompt: "a calm kitchen", aspectRatio: "16:9", resolution: "1K" } as const;

interface Call {
  url: string;
  init: RequestInit;
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function provider(respond: (call: Call) => Response | Promise<Response>, calls: Call[] = []) {
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return new OpenRouterImageProvider({ apiKey: KEY, model: MODEL, estimatedCostUsd: 0.0184, fetchImpl });
}

async function failureOf(run: Promise<unknown>): Promise<ImageProviderError> {
  try {
    await run;
  } catch (error) {
    expect(error).toBeInstanceOf(ImageProviderError);
    return error as ImageProviderError;
  }
  throw new Error("expected the call to fail");
}

describe("OpenRouterImageProvider request", () => {
  it("posts one image request to the OpenRouter image API with the bearer key", async () => {
    const calls: Call[] = [];
    const p = provider(() => json({ data: [{ b64_json: IMAGE_B64, media_type: "image/png" }], usage: { cost: 0.0184 } }), calls);

    await p.generate(REQUEST);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://openrouter.ai/api/v1/images");
    expect(calls[0]!.init.method).toBe("POST");
    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      model: MODEL,
      prompt: "a calm kitchen",
      aspect_ratio: "16:9",
      resolution: "1K",
      n: 1,
    });
  });

  it("returns the decoded bytes, media type, model and the cost the API reports", async () => {
    const p = provider(() => json({ data: [{ b64_json: IMAGE_B64, media_type: "image/png" }], usage: { cost: 0.02 } }));

    const image = await p.generate(REQUEST);

    expect(Array.from(image.bytes)).toEqual(Array.from(IMAGE_BYTES));
    expect(image.mediaType).toBe("image/png");
    expect(image.model).toBe(MODEL);
    expect(image.costUsd).toBe(0.02);
  });

  it("uses the configured estimate when the response carries no cost", async () => {
    const p = provider(() => json({ data: [{ b64_json: IMAGE_B64 }] }));

    const image = await p.generate(REQUEST);

    expect(image.costUsd).toBe(0.0184);
    expect(image.mediaType).toBeUndefined();
  });

  it("honours a custom base URL without a double slash", async () => {
    const calls: Call[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return json({ data: [{ b64_json: IMAGE_B64 }] });
    }) as typeof fetch;
    const p = new OpenRouterImageProvider({
      apiKey: KEY,
      model: MODEL,
      estimatedCostUsd: 0.0184,
      baseUrl: "https://gateway.example.com/v1/",
      fetchImpl,
    });

    await p.generate(REQUEST);

    expect(calls[0]!.url).toBe("https://gateway.example.com/v1/images");
  });

  it("refuses to be built without a key, a model or a positive cost estimate", () => {
    const base = { apiKey: KEY, model: MODEL, estimatedCostUsd: 0.0184 };
    expect(() => new OpenRouterImageProvider({ ...base, apiKey: "" })).toThrow(/OPENROUTER_API_KEY/);
    expect(() => new OpenRouterImageProvider({ ...base, model: "" })).toThrow(/IMAGE_MODEL/);
    expect(() => new OpenRouterImageProvider({ ...base, estimatedCostUsd: 0 })).toThrow(/cost/i);
  });
});

describe("OpenRouterImageProvider failures", () => {
  it.each([
    [401, "auth"],
    [403, "auth"],
    [402, "credits"],
    [500, "transient"],
    [503, "transient"],
    [400, "permanent"],
    [404, "permanent"],
  ] as const)("maps HTTP %i to %s", async (status, kind) => {
    const p = provider(() => json({ error: { message: "nope" } }, { status }));

    const error = await failureOf(p.generate(REQUEST));

    expect(error.kind).toBe(kind);
    expect(error.status).toBe(status);
  });

  it("reports rate limiting with the Retry-After delay in milliseconds", async () => {
    const p = provider(() => json({ error: { message: "slow down" } }, { status: 429, headers: { "retry-after": "7" } }));

    const error = await failureOf(p.generate(REQUEST));

    expect(error.kind).toBe("rate_limited");
    expect(error.retryAfterMs).toBe(7000);
  });

  it("treats a network failure as transient and an aborted call as a timeout", async () => {
    const down = provider(() => {
      throw new TypeError("fetch failed");
    });
    expect((await failureOf(down.generate(REQUEST))).kind).toBe("transient");

    const controller = new AbortController();
    controller.abort();
    const aborted = new OpenRouterImageProvider({
      apiKey: KEY,
      model: MODEL,
      estimatedCostUsd: 0.0184,
      fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
        return json({ data: [{ b64_json: IMAGE_B64 }] });
      }) as typeof fetch,
    });
    expect((await failureOf(aborted.generate(REQUEST, controller.signal))).kind).toBe("timeout");
  });

  it.each([
    ["no data", { data: [] }],
    ["an empty image", { data: [{ b64_json: "" }] }],
    ["a URL instead of bytes", { data: [{ url: "https://cdn.example.com/x.png" }] }],
    ["a body that is not the expected shape", { images: [] }],
  ])("rejects a response with %s", async (_label, body) => {
    const calls: Call[] = [];
    const p = provider(() => json(body), calls);

    const error = await failureOf(p.generate(REQUEST));

    expect(error.kind).toBe("permanent");
    // A returned URL is never fetched: the only network call is the API request.
    expect(calls).toHaveLength(1);
  });

  it("rejects a body that is not JSON", async () => {
    const p = provider(() => new Response("<html>gateway error</html>", { status: 200 }));

    expect((await failureOf(p.generate(REQUEST))).kind).toBe("permanent");
  });

  it("never lets the API key reach an error message", async () => {
    const p = provider(() => json({ error: { message: `invalid key ${KEY}` } }, { status: 400 }));

    const error = await failureOf(p.generate(REQUEST));

    expect(error.message).not.toContain(KEY);
    expect(error.message).toContain("[redacted]");
  });
});
