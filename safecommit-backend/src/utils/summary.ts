import type { Finding } from "../schema";

export function buildSummary(findings: Finding[], durationMs: number) {
  const bySeverity: Record<string, number> = {
    nit: 0,
    suggestion: 0,
    warning: 0,
    critical: 0
  };

  for (const finding of findings) {
    bySeverity[finding.severity] = (bySeverity[finding.severity] || 0) + 1;
  }

  return {
    totalFindings: findings.length,
    bySeverity,
    durationMs
  };
}
