import type { Finding, Summary } from "./schema";

export function buildSystemPrompt(): string {
  return [
    "You are a careful code reviewer.",
    "Review only the staged diff provided.",
    "Return ONLY valid JSON matching the schema. No markdown, no commentary.",
    "If no issues are found, return findings as an empty array and a correct summary.",
    "Severities must be one of: nit, suggestion, warning, critical.",
    "Map each finding to an existing file path and line range in the file.",
    "Prefer actionable guidance and minimal patches.",
    "Make the message and rationale detailed and specific, including impact and concrete fix guidance.",
    "Be conservative; avoid nitpicks unless clearly beneficial.",
    "Summary counts must exactly match the findings array.",
  ].join(" ");
}

export function buildUserPrompt(diff: string, files: string[]): string {
  const schemaHint = JSON.stringify(
    {
      findings: [
        {
          file: "string",
          lineStart: 1,
          lineEnd: 1,
          severity: "warning",
          title: "string",
          message: "string",
          rationale: "string",
          patch: "string",
        },
      ],
      summary: {
        totalFindings: 1,
        bySeverity: {
          nit: 0,
          suggestion: 0,
          warning: 1,
          critical: 0,
        },
        durationMs: 1,
      },
    },
    null,
    2,
  );

  return [
    "You must review ONLY the staged diff below.",
    "File list:",
    files.join("\n"),
    "Staged diff:",
    diff,
    "Return ONLY valid JSON matching this schema:",
    schemaHint,
  ].join("\n\n");
}

export function buildRepairPrompt(badOutput: string): string {
  return [
    "The previous response was invalid.",
    "Return ONLY valid JSON matching the required schema. No markdown, no commentary.",
    "Here is the invalid output:",
    badOutput,
  ].join("\n\n");
}

export type ReviewPayload = {
  findings: Finding[];
  summary: Summary;
};
