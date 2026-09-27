#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { AnalyzeImagesSchema, FEATURES, annotateImages, formatMarkdown } from "./vision.js";

const API_KEY = process.env.GOOGLE_VISION_API_KEY || process.env.GOOGLE_API_KEY;
if (!API_KEY) {
  process.stderr.write("GOOGLE_VISION_API_KEY (or GOOGLE_API_KEY) is required\n");
  process.exit(1);
}
const TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT ?? 30_000);

const server = new Server({ name: "google-vision-mcp", version: "0.1.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "vision_analyze_images",
      title: "Analyze Images with Google Cloud Vision",
      description:
        "Run Google Cloud Vision on 1–16 public image URLs and return a compact, SEO-oriented summary per image. " +
        "Features: labels (what Google thinks the image shows), objects (detected objects with score and share of the image area — main-subject check), " +
        "text (OCR word count and excerpt — legibility of packaging or overlay text), web (best-guess label, web entities, and where identical images appear — " +
        "full matches on other sites indicate stock or reused imagery rather than an own photo), safe-search, faces (emotion likelihoods), " +
        "properties (dominant colours), crop-hints (salient crop for 1.91:1, 16:9, 4:3 and 1:1 — does the subject survive a Discover or og:image crop). " +
        "Default features: labels, objects, text, web. Billed per image and feature; request only what the question needs.",
      inputSchema: {
        type: "object",
        properties: {
          imageUrls: { type: "array", items: { type: "string", format: "uri" }, minItems: 1, maxItems: 16, description: "Public http(s) image URLs." },
          features: {
            type: "array",
            items: { type: "string", enum: Object.keys(FEATURES) },
            minItems: 1,
            default: ["labels", "objects", "text", "web"],
            description: "Vision features to request.",
          },
          maxResults: { type: "integer", minimum: 1, maximum: 50, default: 10, description: "Maximum results per feature." },
          responseFormat: { type: "string", enum: ["markdown", "json"], default: "markdown", description: "markdown is concise; json returns the structured summary." },
        },
        required: ["imageUrls"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const { name, arguments: args } = request.params;
  if (name !== "vision_analyze_images") {
    return { content: [{ type: "text", text: `Error: unknown tool '${name}'. Use vision_analyze_images.` }], isError: true };
  }
  const parsed = AnalyzeImagesSchema.safeParse(args ?? {});
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
    return { content: [{ type: "text", text: `Error: ${detail}` }], isError: true };
  }

  const results = await annotateImages(parsed.data, { apiKey: API_KEY, timeoutMs: TIMEOUT_MS }, extra.signal);
  const structured = { results };
  const text = parsed.data.responseFormat === "json" ? JSON.stringify(structured, null, 2) : formatMarkdown(results);
  return {
    content: [{ type: "text", text }],
    structuredContent: structured,
    isError: results.every((r) => r.error) ? true : undefined,
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
