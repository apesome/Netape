import { redactAiContext, type AiConfig, type AiMessage, type AiProfile } from "./ai.ts";

/** Pick only a configured service; preserve the current tab's valid choice. */
export function companionProfile(config: AiConfig, current: string): string {
  const ready = config.profiles;
  return ready.find(profile => profile.id === current)?.id
    ?? ready.find(profile => profile.id === config.activeProfile)?.id
    ?? ready[0]?.id ?? "";
}

/** Model choices belong to a service endpoint and this terminal tab. */
export function companionServiceKey(profile: AiProfile): string {
  return JSON.stringify([profile.id, profile.baseUrl, profile.protocol ?? "openai"]);
}

export function companionModel(profile: AiProfile | undefined, choices: Record<string, string>): string {
  return profile ? (choices[companionServiceKey(profile)] ?? profile.model).trim() : "";
}

export const COMPANION_LAST_MODEL_KEY = "netape-ai-last-model";

export function companionLastModel(config: AiConfig, raw: string | null): { profileId: string; choices: Record<string, string> } | null {
  try {
    if (!raw) return null;
    const value = JSON.parse(raw);
    if (!value || typeof value.source !== "string" || typeof value.model !== "string") return null;
    const model = value.model.trim();
    if (!model || new TextEncoder().encode(model).length > 200 || /[\x00-\x1f\x7f]/.test(model)) return null;
    const profile = config.profiles.find(item => companionServiceKey(item) === value.source);
    return profile ? { profileId: profile.id, choices: { [value.source]: model } } : null;
  } catch { return null; }
}

/** Never send an orphaned assistant response when retrying a failed turn. */
export function companionRetry(messages: AiMessage[]): AiMessage[] {
  let lastUser = messages.length - 1;
  while (lastUser >= 0 && messages[lastUser].role !== "user") lastUser--;
  return lastUser < 0 ? [] : messages.slice(0, lastUser + 1);
}

export function companionContext(parts: string[]): string {
  return [...new Set(parts.map(part => redactAiContext(part).trim()).filter(Boolean))]
    .join("\n\n").slice(0, 64000);
}

export function companionMarkdown(messages: AiMessage[], title: string): string {
  return `# ${title}\n\n${messages.map(message => `## ${message.role === "user" ? "You" : "AI"}\n\n${message.content}`).join("\n\n")}`;
}
