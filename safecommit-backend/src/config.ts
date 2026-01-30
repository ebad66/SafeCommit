import dotenv from "dotenv";

dotenv.config();

const parseIntEnv = (value: string | undefined, fallback: number): number => {
  const parsed = value ? Number.parseInt(value, 10) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const config = {
  port: parseIntEnv(process.env.PORT, 8787),
  geminiApiKey: process.env.GEMINI_API_KEY || "",
  defaultMaxDiffBytes: parseIntEnv(process.env.DEFAULT_MAX_DIFF_BYTES, 200000),
  llmTimeoutMs: parseIntEnv(process.env.LLM_TIMEOUT_MS, 60000)
};
