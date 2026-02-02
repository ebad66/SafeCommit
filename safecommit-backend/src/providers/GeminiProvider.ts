import { GoogleGenerativeAI } from "@google/generative-ai";
import type { LLMProvider } from "./LLMProvider";
import {
  buildRepairPrompt,
  buildSystemPrompt,
  buildUserPrompt,
} from "../prompt";
import { reviewResponseSchema } from "../schema";
import { safeParseJson } from "../utils/parseJson";
import { withTimeout } from "../utils/timeout";
import { config } from "../config";

export class GeminiProvider implements LLMProvider {
  private model;
  private systemPrompt: string;

  constructor() {
    if (!config.geminiApiKey) {
      throw new Error("GEMINI_API_KEY is required");
    }
    const genAI = new GoogleGenerativeAI(config.geminiApiKey);
    this.systemPrompt = buildSystemPrompt();
    this.model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
      systemInstruction: this.systemPrompt,
      generationConfig: {
        responseMimeType: "application/json",
      },
    });
  }

  async reviewDiff(diff: string, files: string[]) {
    const userPrompt = buildUserPrompt(diff, files);
    if (config.debugPrompts) {
      console.log("SafeCommit DEBUG system prompt:\n", this.systemPrompt);
      console.log("SafeCommit DEBUG user prompt:\n", userPrompt);
    }
    const first = await withTimeout(
      this.model.generateContent(userPrompt),
      config.llmTimeoutMs,
      "Gemini request timed out",
    );
    const firstText = first.response.text();

    const parsed = this.tryParse(firstText);
    if (parsed.ok) {
      return { findings: parsed.data.findings };
    }

    const repairPrompt = buildRepairPrompt(firstText);
    const repair = await withTimeout(
      this.model.generateContent(repairPrompt),
      config.llmTimeoutMs,
      "Gemini repair request timed out",
    );
    const repairText = repair.response.text();
    const repaired = this.tryParse(repairText);
    if (!repaired.ok) {
      throw new Error("Model returned invalid JSON after repair attempt");
    }

    return { findings: repaired.data.findings };
  }

  private tryParse(
    text: string,
  ): { ok: true; data: { findings: unknown } } | { ok: false; error: Error } {
    try {
      const json = safeParseJson(text);
      const parsed = reviewResponseSchema.safeParse(json);
      if (!parsed.success) {
        return { ok: false, error: new Error("Schema validation failed") };
      }
      return { ok: true, data: parsed.data };
    } catch (error) {
      return { ok: false, error: error as Error };
    }
  }
}
