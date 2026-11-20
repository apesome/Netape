import prompts from "./aiSystemPrompts.json" with { type: "json" };

export function defaultAiSystemPrompt(language: string): string {
  return ["zh_CN", "en", "de", "ja"].includes(language) ? prompts[language as "zh_CN" | "en" | "de" | "ja"] : prompts.en;
}

export function isAutomaticAiSystemPrompt(prompt: string): boolean {
  return !prompt.trim() || prompt === prompts.legacy;
}

export function effectiveAiSystemPrompt(prompt: string, language: string): string {
  return isAutomaticAiSystemPrompt(prompt) ? defaultAiSystemPrompt(language) : prompt;
}
