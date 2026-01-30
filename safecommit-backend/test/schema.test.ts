import { describe, it, expect } from "vitest";
import { reviewResponseSchema } from "../src/schema";

describe("reviewResponseSchema", () => {
  it("accepts a valid response shape", () => {
    const parsed = reviewResponseSchema.safeParse({
      findings: [
        {
          file: "src/index.ts",
          lineStart: 1,
          lineEnd: 1,
          severity: "warning",
          title: "Example",
          message: "Example message",
          rationale: "Example rationale"
        }
      ],
      summary: {
        totalFindings: 1,
        bySeverity: {
          nit: 0,
          suggestion: 0,
          warning: 1,
          critical: 0
        },
        durationMs: 10
      }
    });

    expect(parsed.success).toBe(true);
  });
});
