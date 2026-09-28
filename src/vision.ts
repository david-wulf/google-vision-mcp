import { z } from "zod";

/** Tool-facing feature names mapped to Vision API feature types. */
export const FEATURES = {
  labels: "LABEL_DETECTION",
  objects: "OBJECT_LOCALIZATION",
  text: "TEXT_DETECTION",
  web: "WEB_DETECTION",
  "safe-search": "SAFE_SEARCH_DETECTION",
  faces: "FACE_DETECTION",
  properties: "IMAGE_PROPERTIES",
  "crop-hints": "CROP_HINTS",
} as const;

export type Feature = keyof typeof FEATURES;
const FEATURE_NAMES = Object.keys(FEATURES) as [Feature, ...Feature[]];

// og:image 1.91:1, 16:9 for Discover, 4:3, square thumbnail.
export const CROP_ASPECT_RATIOS = [1.91, 1.78, 1.33, 1];

const MAX_IMAGE_BYTES = 7 * 1024 * 1024; // base64 grows ~4/3; Vision caps a JSON request at 10 MB
const ENDPOINT = "https://vision.googleapis.com/v1/images:annotate";

const HttpUrl = z
  .string()
  .url()
  .refine((v) => /^https?:$/.test(new URL(v).protocol), "URL must use http:// or https://");

export const AnalyzeImagesSchema = z
  .object({
    imageUrls: z.array(HttpUrl).min(1).max(16),
    features: z.array(z.enum(FEATURE_NAMES)).min(1).default(["labels", "objects", "text", "web"]),
    maxResults: z.number().int().min(1).max(50).default(10),
    responseFormat: z.enum(["markdown", "json"]).default("markdown"),
  })
  .strict();

export type AnalyzeImagesInput = z.infer<typeof AnalyzeImagesSchema>;

export interface VisionConfig {
  apiKey: string;
  timeoutMs: number;
  fetchFn?: typeof fetch;
}

// ---------------------------------------------------------------------------
// Request side
// ---------------------------------------------------------------------------

/**
 * Download the image ourselves and send its bytes. Letting Google fetch the
 * imageUri fails silently on many shops and CDNs ("We can not access the URL
 * currently"), so the URI is only the fallback when our own download fails.
 */
async function imagePayload(url: string, cfg: VisionConfig, signal?: AbortSignal): Promise<{ image: Record<string, unknown>; source: "content" | "uri" }> {
  const fetchFn = cfg.fetchFn ?? fetch;
  try {
    const res = await fetchFn(url, {
      signal: withTimeout(cfg.timeoutMs, signal),
      headers: { "User-Agent": "Mozilla/5.0 (compatible; google-vision-mcp/0.1)", Accept: "image/*" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > MAX_IMAGE_BYTES) throw new Error("image too large to inline");
    return { image: { content: buf.toString("base64") }, source: "content" };
  } catch (err) {
    if (signal?.aborted) throw err;
    return { image: { source: { imageUri: url } }, source: "uri" };
  }
}

function withTimeout(ms: number, outer?: AbortSignal): AbortSignal {
  const t = AbortSignal.timeout(ms);
  return outer ? AbortSignal.any([t, outer]) : t;
}

function buildFeatures(features: Feature[], maxResults: number) {
  return features.map((f) => ({ type: FEATURES[f], maxResults }));
}

export async function annotateImage(
  url: string,
  input: Pick<AnalyzeImagesInput, "features" | "maxResults">,
  cfg: VisionConfig,
  signal?: AbortSignal,
): Promise<ImageResult> {
  const fetchFn = cfg.fetchFn ?? fetch;
  const redact = (s: string) => s.replaceAll(cfg.apiKey, "[REDACTED]");
  try {
    const { image, source } = await imagePayload(url, cfg, signal);
    const request: Record<string, unknown> = { image, features: buildFeatures(input.features, input.maxResults) };
    if (input.features.includes("crop-hints")) {
      request.imageContext = { cropHintsParams: { aspectRatios: CROP_ASPECT_RATIOS } };
    }

    const res = await fetchFn(`${ENDPOINT}?key=${cfg.apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requests: [request] }),
      signal: withTimeout(cfg.timeoutMs, signal),
    });
    const body = await res.text();
    if (!res.ok) throw new Error(explainApiError(res.status, body));

    const response = JSON.parse(body).responses?.[0] ?? {};
    if (response.error) throw new Error(`Vision could not process the image: ${response.error.message ?? response.error.code}`);
    return { url, source, ...summarise(url, response, input.features) };
  } catch (err) {
    return { url, error: redact(err instanceof Error ? err.message : String(err)) };
  }
}

function explainApiError(status: number, body: string): string {
  if (status === 400 && /API key not valid|API_KEY_INVALID/i.test(body)) {
    return "Vision rejected the API key. It must be a Google Cloud key (AIza…) from a project with the Cloud Vision API enabled.";
  }
  if (status === 403) {
    return `Vision refused the request (403): the API is not enabled for the key's project, billing is missing, or the key is restricted. Google says: ${body.slice(0, 400)}`;
  }
  if (status === 429) return "Vision rate-limited the request (429). Retry later or send fewer images.";
  return `Vision API error ${status}: ${body.slice(0, 400)}`;
}

/** Annotate several images with bounded concurrency; one failure never sinks the batch. */
export async function annotateImages(input: AnalyzeImagesInput, cfg: VisionConfig, signal?: AbortSignal): Promise<ImageResult[]> {
  const results: ImageResult[] = new Array(input.imageUrls.length);
  let next = 0;
  const worker = async () => {
    while (next < input.imageUrls.length) {
      const i = next++;
      results[i] = await annotateImage(input.imageUrls[i], input, cfg, signal);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, input.imageUrls.length) }, worker));
  return results;
}

// ---------------------------------------------------------------------------
// Response side: compact, SEO-relevant summary instead of the raw payload
// ---------------------------------------------------------------------------

export interface ImageResult {
  url: string;
  source?: "content" | "uri";
  error?: string;
  labels?: { description: string; score: number }[];
  objects?: { name: string; score: number; areaShare: number }[];
  text?: { wordCount: number; locale?: string; excerpt: string };
  web?: {
    bestGuess: string[];
    entities: { description: string; score: number }[];
    fullMatches: number;
    partialMatches: number;
    pagesWithMatches: number;
    foreignFullMatchHosts: string[];
    samplePages: string[];
  };
  safeSearch?: Record<string, string>;
  faces?: { count: number; faces: { confidence: number; joy: string; sorrow: string; anger: string; surprise: string }[] };
  colors?: { hex: string; pixelFraction: number }[];
  cropHints?: { aspectRatio: number; confidence: number; importanceFraction: number; box: string }[];
}

const round = (n: number | undefined, d = 2) => Math.round((n ?? 0) * 10 ** d) / 10 ** d;

// Second-level suffixes under which the registrable domain has three labels (co.uk, com.au, …).
const MULTI_LABEL_SUFFIX = /^(co|com|net|org|gov|ac|edu|ne|or)\.[a-z]{2}$/;

/** Registrable-domain approximation: good enough to tell "our CDN" from "someone else's site". */
export function siteOf(url: string): string {
  try {
    const parts = new URL(url).hostname.replace(/^www\./, "").split(".");
    const n = MULTI_LABEL_SUFFIX.test(parts.slice(-2).join(".")) ? 3 : 2;
    return parts.slice(-n).join(".");
  } catch {
    return url;
  }
}

export function summarise(url: string, r: any, features: Feature[]): Omit<ImageResult, "url" | "source"> {
  const out: Omit<ImageResult, "url" | "source"> = {};
  const has = (f: Feature) => features.includes(f);

  if (has("labels")) {
    out.labels = (r.labelAnnotations ?? []).map((l: any) => ({ description: l.description, score: round(l.score) }));
  }
  if (has("objects")) {
    out.objects = (r.localizedObjectAnnotations ?? []).map((o: any) => {
      const v = o.boundingPoly?.normalizedVertices ?? [];
      const xs = v.map((p: any) => p.x ?? 0);
      const ys = v.map((p: any) => p.y ?? 0);
      const area = xs.length ? (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys)) : 0;
      return { name: o.name, score: round(o.score), areaShare: round(area) };
    });
  }
  if (has("text")) {
    const full = r.fullTextAnnotation?.text ?? r.textAnnotations?.[0]?.description ?? "";
    const words = full.split(/\s+/).filter(Boolean);
    out.text = {
      wordCount: words.length,
      locale: r.textAnnotations?.[0]?.locale,
      excerpt: full.length > 600 ? `${full.slice(0, 600)}…` : full,
    };
  }
  if (has("web")) {
    const w = r.webDetection ?? {};
    const own = siteOf(url);
    const full: string[] = (w.fullMatchingImages ?? []).map((m: any) => m.url);
    out.web = {
      bestGuess: (w.bestGuessLabels ?? []).map((b: any) => b.label),
      entities: (w.webEntities ?? []).filter((e: any) => e.description).map((e: any) => ({ description: e.description, score: round(e.score) })),
      fullMatches: full.length,
      partialMatches: (w.partialMatchingImages ?? []).length,
      pagesWithMatches: (w.pagesWithMatchingImages ?? []).length,
      foreignFullMatchHosts: [...new Set(full.map(siteOf).filter((s) => s !== own))],
      samplePages: (w.pagesWithMatchingImages ?? []).slice(0, 5).map((p: any) => p.url),
    };
  }
  if (has("safe-search") && r.safeSearchAnnotation) {
    const { adult, spoof, medical, violence, racy } = r.safeSearchAnnotation;
    out.safeSearch = { adult, spoof, medical, violence, racy };
  }
  if (has("faces")) {
    const faces = r.faceAnnotations ?? [];
    out.faces = {
      count: faces.length,
      faces: faces.map((f: any) => ({
        confidence: round(f.detectionConfidence),
        joy: f.joyLikelihood,
        sorrow: f.sorrowLikelihood,
        anger: f.angerLikelihood,
        surprise: f.surpriseLikelihood,
      })),
    };
  }
  if (has("properties")) {
    const colors = r.imagePropertiesAnnotation?.dominantColors?.colors ?? [];
    out.colors = colors.slice(0, 5).map((c: any) => ({
      hex: "#" + ["red", "green", "blue"].map((k) => Math.round(c.color?.[k] ?? 0).toString(16).padStart(2, "0")).join(""),
      pixelFraction: round(c.pixelFraction),
    }));
  }
  if (has("crop-hints")) {
    const hints = r.cropHintsAnnotation?.cropHints ?? [];
    out.cropHints = hints.map((h: any, i: number) => {
      const v = h.boundingPoly?.vertices ?? [];
      const xs = v.map((p: any) => p.x ?? 0);
      const ys = v.map((p: any) => p.y ?? 0);
      const box = xs.length ? `${Math.min(...xs)},${Math.min(...ys)} → ${Math.max(...xs)},${Math.max(...ys)} px` : "–";
      return { aspectRatio: CROP_ASPECT_RATIOS[i] ?? 0, confidence: round(h.confidence), importanceFraction: round(h.importanceFraction), box };
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

export function formatMarkdown(results: ImageResult[]): string {
  const blocks = results.map((r, i) => {
    const lines = [`## Image ${i + 1}`, "", `**URL:** ${r.url}`];
    if (r.error) return [...lines, "", `**Error:** ${r.error}`].join("\n");
    if (r.source === "uri") lines.push("_Download failed locally; Google fetched the URL itself._");

    if (r.labels) lines.push("", "**Labels:** " + (r.labels.map((l) => `${l.description} (${l.score})`).join(", ") || "none"));
    if (r.objects) {
      lines.push("", "**Objects** (score · share of image area):");
      lines.push(...(r.objects.length ? r.objects.map((o) => `- ${o.name} · ${o.score} · ${Math.round(o.areaShare * 100)} %`) : ["- none detected"]));
    }
    if (r.text) {
      lines.push("", `**Text (OCR):** ${r.text.wordCount} words${r.text.locale ? `, language ${r.text.locale}` : ""}`);
      if (r.text.excerpt) lines.push("", "```", r.text.excerpt, "```");
    }
    if (r.web) {
      const w = r.web;
      lines.push(
        "",
        "**Web detection:**",
        `- Best guess: ${w.bestGuess.join(", ") || "–"}`,
        `- Entities: ${w.entities.map((e) => `${e.description} (${e.score})`).join(", ") || "–"}`,
        `- Matches: ${w.fullMatches} full, ${w.partialMatches} partial, on ${w.pagesWithMatches} pages`,
        `- Full matches on other sites: ${w.foreignFullMatchHosts.length ? w.foreignFullMatchHosts.join(", ") : "none"}`,
      );
      if (w.samplePages.length) lines.push(`- Sample pages: ${w.samplePages.join(" · ")}`);
    }
    if (r.safeSearch) lines.push("", "**SafeSearch:** " + Object.entries(r.safeSearch).map(([k, v]) => `${k} ${v}`).join(", "));
    if (r.faces) {
      lines.push("", `**Faces:** ${r.faces.count}`);
      lines.push(...r.faces.faces.map((f, n) => `- Face ${n + 1} (${f.confidence}): joy ${f.joy}, sorrow ${f.sorrow}, anger ${f.anger}, surprise ${f.surprise}`));
    }
    if (r.colors) lines.push("", "**Dominant colours:** " + (r.colors.map((c) => `${c.hex} (${Math.round(c.pixelFraction * 100)} %)`).join(", ") || "–"));
    if (r.cropHints) {
      lines.push("", "**Crop hints:**");
      lines.push(...r.cropHints.map((h) => `- ${h.aspectRatio}:1 → ${h.box}, confidence ${h.confidence}, keeps ${Math.round(h.importanceFraction * 100)} % of the salient content`));
    }
    return lines.join("\n");
  });

  const failed = results.filter((r) => r.error).length;
  const head = `# Vision Analysis\n\n${results.length} image(s), ${results.length - failed} analysed${failed ? `, ${failed} failed` : ""}.`;
  return [head, ...blocks].join("\n\n");
}
