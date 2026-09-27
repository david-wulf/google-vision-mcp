import { describe, it, expect } from "vitest";
import { AnalyzeImagesSchema, annotateImages, formatMarkdown, siteOf, summarise } from "./vision.js";

const KEY = "AIzaTEST-secret-key";

const visionResponse = {
  responses: [
    {
      labelAnnotations: [{ description: "Solar panel", score: 0.973 }],
      localizedObjectAnnotations: [
        { name: "Solar panel", score: 0.91, boundingPoly: { normalizedVertices: [{ x: 0.1, y: 0.1 }, { x: 0.6, y: 0.1 }, { x: 0.6, y: 0.9 }, { x: 0.1, y: 0.9 }] } },
      ],
      fullTextAnnotation: { text: "800 W Balkonkraftwerk" },
      textAnnotations: [{ locale: "de", description: "800 W Balkonkraftwerk" }],
      webDetection: {
        bestGuessLabels: [{ label: "balkonkraftwerk" }],
        webEntities: [{ description: "Photovoltaics", score: 0.8 }, { score: 0.1 }],
        fullMatchingImages: [{ url: "https://cdn.example.de/a.jpg" }, { url: "https://www.stock.com/x.jpg" }],
        partialMatchingImages: [{ url: "https://other.org/y.jpg" }],
        pagesWithMatchingImages: [{ url: "https://stock.com/page" }],
      },
    },
  ],
};

function fakeFetch(opts: { imageStatus?: number; visionStatus?: number } = {}) {
  const calls: { url: string; body?: any }[] = [];
  const fn = (async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body });
    if (url.startsWith("https://vision.googleapis.com")) {
      const status = opts.visionStatus ?? 200;
      return new Response(status === 200 ? JSON.stringify(visionResponse) : `{"error":{"message":"API key not valid ${KEY}"}}`, { status });
    }
    return new Response(new Uint8Array([1, 2, 3]), { status: opts.imageStatus ?? 200 });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe("summarise", () => {
  it("reduces the Vision payload to SEO-relevant fields", () => {
    const s = summarise("https://www.example.de/a.jpg", visionResponse.responses[0], ["labels", "objects", "text", "web"]);
    expect(s.labels).toEqual([{ description: "Solar panel", score: 0.97 }]);
    expect(s.objects?.[0].areaShare).toBe(0.4);
    expect(s.text).toMatchObject({ wordCount: 3, locale: "de" });
    expect(s.web?.foreignFullMatchHosts).toEqual(["stock.com"]);
    expect(s.web?.entities).toHaveLength(1);
  });

  it("only reports requested features", () => {
    const s = summarise("https://example.de/a.jpg", visionResponse.responses[0], ["labels"]);
    expect(Object.keys(s)).toEqual(["labels"]);
  });
});

describe("annotateImages", () => {
  it("inlines the downloaded bytes and asks for crop ratios only when requested", async () => {
    const { fn, calls } = fakeFetch();
    const input = AnalyzeImagesSchema.parse({ imageUrls: ["https://example.de/a.jpg"], features: ["labels", "crop-hints"] });
    const [r] = await annotateImages(input, { apiKey: KEY, timeoutMs: 1000, fetchFn: fn });
    expect(r.source).toBe("content");
    const req = calls.find((c) => c.url.startsWith("https://vision"))!.body.requests[0];
    expect(req.image.content).toBe(Buffer.from([1, 2, 3]).toString("base64"));
    expect(req.imageContext.cropHintsParams.aspectRatios).toContain(1.91);
  });

  it("falls back to imageUri when the local download fails", async () => {
    const { fn, calls } = fakeFetch({ imageStatus: 403 });
    const input = AnalyzeImagesSchema.parse({ imageUrls: ["https://example.de/a.jpg"] });
    const [r] = await annotateImages(input, { apiKey: KEY, timeoutMs: 1000, fetchFn: fn });
    expect(r.source).toBe("uri");
    expect(calls.at(-1)!.body.requests[0].image).toEqual({ source: { imageUri: "https://example.de/a.jpg" } });
  });

  it("reports API errors per image without leaking the key", async () => {
    const { fn } = fakeFetch({ visionStatus: 500 });
    const input = AnalyzeImagesSchema.parse({ imageUrls: ["https://example.de/a.jpg", "https://example.de/b.jpg"] });
    const results = await annotateImages(input, { apiKey: KEY, timeoutMs: 1000, fetchFn: fn });
    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(r.error).toBeDefined();
      expect(r.error).not.toContain(KEY);
    }
    expect(formatMarkdown(results)).toContain("2 failed");
  });
});

describe("schema", () => {
  it("rejects non-http URLs and more than 16 images", () => {
    expect(AnalyzeImagesSchema.safeParse({ imageUrls: ["file:///etc/passwd"] }).success).toBe(false);
    expect(AnalyzeImagesSchema.safeParse({ imageUrls: Array(17).fill("https://a.de/x.jpg") }).success).toBe(false);
  });
});

it("siteOf strips www and subdomains", () => {
  expect(siteOf("https://cdn.shopify.com/x.jpg")).toBe("shopify.com");
  expect(siteOf("https://www.solakon.de/a")).toBe("solakon.de");
});
