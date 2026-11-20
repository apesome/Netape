export type AiProtocol = "openai" | "anthropic";
export interface AiProfile { id: string; name: string; baseUrl: string; model: string; hasKey: boolean; protocol?: AiProtocol; providerId?: string; editionId?: string; }
export interface AiConfig {
  profiles: AiProfile[]; activeProfile: string; systemPrompt: string; maxTokens: number; timeoutSecs: number;
  contextLines: number; attachOutput: boolean; attachHost: boolean; permission: "suggest" | "paste" | "confirm"; saveHistory: boolean;
}
export interface AiMessage { id: string; role: "user" | "assistant"; content: string; }
export interface AiConversation { id: string; scope: string; title: string; updated: number; messages: {role: "user" | "assistant"; content: string}[]; }
export interface TerminalApi {
  write: (data: string) => void;
  getSelection: () => string;
  getOutput: (lines: number) => string;
  paste: (text: string) => Promise<void>;
  execute: (text: string) => Promise<void>;
}
export function terminalText(term: {buffer: {active: {length:number;getLine:(i:number)=>{translateToString:(trim:boolean)=>string}|undefined}}}, lines: number): string {
  const b=term.buffer.active, result=[];
  for(let i=Math.max(0,b.length-Math.max(1,Math.min(2000,lines)));i<b.length;i++)result.push(b.getLine(i)?.translateToString(true)??"");
  return result.join("\n").trim().slice(-64000);
}
/** Remove common secret formats from explicitly shared terminal output. */
export function redactAiContext(text: string): string {
  return text.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g,"[private key removed]")
    .replace(/\b(Bearer\s+)[\w.\-+/=]+/gi,"$1[redacted]")
    .replace(/\b((?:api[_-]?key|password|passwd|token|secret)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s]+)/gi,"$1[redacted]")
    .replace(/\bsk-[\w-]{12,}/g,"[API key removed]");
}

export function terminalInput(text: string, bracketed: boolean, execute = false): string {
  const clean=text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
  return (bracketed ? `\x1b[200~${clean}\x1b[201~` : clean.replace(/[\r\n]+/g," "))+(execute?"\r":"");
}
