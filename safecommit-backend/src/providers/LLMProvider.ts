import type { Finding } from "../schema";

export interface LLMProvider {
  reviewDiff(diff: string, files: string[]): Promise<{ findings: Finding[] }>;
}
