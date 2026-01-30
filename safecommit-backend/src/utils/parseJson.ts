export function safeParseJson(text: string): unknown {
  const trimmed = text.trim();
  return JSON.parse(trimmed);
}
