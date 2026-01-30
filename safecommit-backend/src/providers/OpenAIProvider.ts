import type { LLMProvider } from "./LLMProvider";
import type { Finding } from "../schema";

export class OpenAIProvider implements LLMProvider {
  async reviewDiff(_diff: string, _files: string[]): Promise<{ findings: Finding[] }> {
    throw new Error("OpenAIProvider is not wired yet");
  }
}
