import { z } from "zod";

export const severityEnum = z.enum(["nit", "suggestion", "warning", "critical"]);

export const findingSchema = z.object({
  file: z.string().min(1),
  lineStart: z.number().int().min(1),
  lineEnd: z.number().int().min(1),
  severity: severityEnum,
  title: z.string().min(1),
  message: z.string().min(1),
  rationale: z.string().min(1),
  patch: z.string().optional()
}).refine((data) => data.lineEnd >= data.lineStart, {
  message: "lineEnd must be greater than or equal to lineStart",
  path: ["lineEnd"]
});

export const findingsSchema = z.array(findingSchema);

export const summarySchema = z.object({
  totalFindings: z.number().int().nonnegative(),
  bySeverity: z.record(z.string(), z.number().int().nonnegative()),
  durationMs: z.number().int().nonnegative()
});

export const reviewResponseSchema = z.object({
  findings: findingsSchema,
  summary: summarySchema
});

export const reviewRequestSchema = z.object({
  repoId: z.string().min(1),
  diff: z.string().min(1),
  files: z.array(z.string().min(1))
});

export type Finding = z.infer<typeof findingSchema>;
export type Summary = z.infer<typeof summarySchema>;
