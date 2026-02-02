import express from "express";
import cors from "cors";
import { randomUUID } from "crypto";
import { config } from "./config";
import { reviewRequestSchema, findingsSchema } from "./schema";
import { GeminiProvider } from "./providers/GeminiProvider";
import { buildSummary } from "./utils/summary";

const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: "300kb" }));

const provider = new GeminiProvider();

const truncateByBytes = (input: string, maxBytes: number): string => {
  const bytes = Buffer.byteLength(input, "utf8");
  if (bytes <= maxBytes) {
    return input;
  }
  const buf = Buffer.from(input, "utf8");
  return buf.subarray(0, maxBytes).toString("utf8");
};

app.post("/v1/review/diff", async (req, res) => {
  const started = Date.now();
  const requestId = randomUUID();

  const parsed = reviewRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      requestId,
      error: "Invalid request",
      details: parsed.error.flatten()
    });
  }

  const { diff, files } = parsed.data;
  const maxBytes = config.defaultMaxDiffBytes;
  const truncatedDiff = truncateByBytes(diff, maxBytes);

  try {
    const review = await provider.reviewDiff(truncatedDiff, files);
    const findingsParsed = findingsSchema.safeParse(review.findings);
    if (!findingsParsed.success) {
      return res.status(502).json({
        requestId,
        error: "Invalid findings from provider"
      });
    }

    const durationMs = Date.now() - started;
    const summary = buildSummary(findingsParsed.data, durationMs);

    return res.json({
      requestId,
      findings: findingsParsed.data,
      summary
    });
  } catch (error) {
    console.error(
      "SafeCommit review failed",
      JSON.stringify({
        requestId,
        diffBytes: Buffer.byteLength(diff, "utf8"),
        filesCount: files.length
      })
    );
    console.error(error);
    return res.status(502).json({
      requestId,
      error: "Failed to review diff",
      message: (error as Error).message
    });
  }
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.listen(config.port, () => {
  console.log(`SafeCommit backend listening on port ${config.port}`);
});
