import directory from "./data/aiProviderDirectory.json" with { type: "json" };
import type { AiProfile, AiProtocol } from "./ai";

export interface AiProviderEdition {
  id: string; name: string; baseUrl: string; protocol?: AiProtocol; anthropicUrl?: string; models?: string[];
}
export interface AiProviderPreset {
  id: string; name: string; editions: AiProviderEdition[]; category?: "provider" | "local"; note?: string;
}

const IDS: Record<string, string> = {
  Anthropic:"anthropic", OpenAI:"openai", "Google Gemini":"google", "xAI Grok":"xai", DeepSeek:"deepseek", Qwen:"qwen", Kimi:"kimi", "Zhipu GLM":"glm", MiniMax:"minimax", "Meta AI":"meta", "Mistral AI":"mistral", Volcengine:"volcengine", "Xiaomi MiMo":"xiaomi", "Tencent Cloud":"tencent", "Baidu Qianfan":"baidu", StepFun:"stepfun", LongCat:"longcat", Cohere:"cohere", Perplexity:"perplexity", "iFlytek Astron Coding Plan":"iflytek", "Ant Ling":"ant", "Nous Portal":"nous", "Agnes AI":"agnes", OpenRouter:"openrouter", Groq:"groq", NVIDIA:"nvidia", "Together AI":"together", "Fireworks AI":"fireworks", "Ollama Cloud":"ollama-cloud", SiliconFlow:"siliconflow", "Huawei Cloud":"huawei", OpenCode:"opencode", "Novita AI":"novita", Baseten:"baseten", ModelScope:"modelscope",
};
const NAMES: Record<string,string> = { qwen:"Qwen / 千问", kimi:"Kimi / Moonshot", glm:"GLM / 智谱", volcengine:"Volcengine / 火山引擎", xiaomi:"Xiaomi MiMo", tencent:"Tencent / 混元", baidu:"Baidu / 千帆", iflytek:"iFlytek / 讯飞星辰", ant:"Ant Ling / 蚂蚁", siliconflow:"SiliconFlow / 硅基流动", huawei:"Huawei / 华为云" };
type Entry = { name:string; group?:string; edition?:string; baseUrl:string; anthropicUrl:string; modelIds?:string[] };
const slug = (value:string) => value.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"");

function buildDirectory(): AiProviderPreset[] {
  const providers: AiProviderPreset[] = [];
  for (const [category,entries] of [["provider",directory.providers]] as const) {
    for (const item of entries as Entry[]) {
      const group = item.group ?? item.name, id = IDS[group] ?? slug(group);
      let provider = providers.find(value=>value.id===id);
      if (!provider) { provider={id,name:NAMES[id]??group,category,editions:[]}; providers.push(provider); }
      if (id === "meta") {
        // Make the OpenRouter route explicit instead
        // of inventing an official API or silently routing terminal context.
        provider.note="Meta Llama 通过 OpenRouter 接入，需要 OpenRouter 的 API Key；模型 ID 可从列表选择或手动输入。";
        provider.editions.push({id:"openrouter",name:"Llama · OpenRouter",baseUrl:"https://openrouter.ai/api/v1"});
        continue;
      }
      const protocol: AiProtocol = item.baseUrl ? "openai" : "anthropic";
      provider.editions.push({ id:slug(item.edition??"api"), name:item.edition??"API", baseUrl:item.baseUrl||item.anthropicUrl, protocol, ...(item.anthropicUrl?{anthropicUrl:item.anthropicUrl}:{}), ...(item.modelIds?.length?{models:item.modelIds}:{}) });
    }
  }
  // Preserve the existing standard API presets alongside the plan editions.
  providers.find(p=>p.id==="qwen")!.editions.unshift(
    {id:"api-cn",name:"API · 中国内地",baseUrl:"https://dashscope.aliyuncs.com/compatible-mode/v1"},
    {id:"api-global",name:"API · International",baseUrl:"https://dashscope-intl.aliyuncs.com/compatible-mode/v1"},
  );
  providers.push({id:"ollama",name:"Ollama 本地",category:"local",editions:[{id:"local",name:"本机 / Local",baseUrl:"http://localhost:11434/v1"}]});
  return providers;
}
export const AI_PROVIDERS = buildDirectory();
export const aiProtocolLabel = (protocol?:AiProtocol) => protocol === "anthropic" ? "Anthropic Messages" : "OpenAI compatible";
export function editionEndpoint(edition:AiProviderEdition, protocol:AiProtocol) {
  return protocol === "anthropic" ? edition.anthropicUrl ?? edition.baseUrl : edition.baseUrl;
}

export function normalizeAiBase(raw: string): string | null {
  try {
    const url=new URL(raw.trim());
    if(!["http:","https:"].includes(url.protocol)||url.username||url.password||url.search||url.hash)return null;
    let path=url.pathname.replace(/\/+$/, "").replace(/\/(?:chat\/completions|models|messages)$/, "");
    if(!path&&url.hostname!=="api.perplexity.ai")path="/v1";
    url.pathname=path;
    return url.toString().replace(/\/$/, "");
  }catch{return null;}
}

export function identifyAiProvider(baseUrl:string, protocol:AiProtocol="openai", providerId?:string) {
  const base=normalizeAiBase(baseUrl);
  const providers = providerId ? AI_PROVIDERS.filter(p=>p.id===providerId) : AI_PROVIDERS.filter(p=>p.id!=="meta");
  for(const provider of providers)for(const edition of provider.editions) {
    if(base===normalizeAiBase(editionEndpoint(edition,protocol)))return {provider:provider.id,edition:edition.id};
  }
  return {provider:"custom",edition:""};
}
export function aiNeedsApiKey(profile: AiProfile): boolean {
  if (profile.hasKey) return false;
  const detected = identifyAiProvider(profile.baseUrl, profile.protocol, profile.providerId);
  return AI_PROVIDERS.some(provider => provider.id === detected.provider && provider.category === "provider");
}
export interface AiCatalog { models: string[]; fetchedAt: number; cached: boolean; }
export interface AiProbe { success: boolean; mode: "connection" | "model"; latencyMs: number; checkedAt: number; error?: string; }
export function aiSourceIdentity(profileId:string, baseUrl:string, key:string|undefined, protocol:AiProtocol="openai") {
  return JSON.stringify([profileId,normalizeAiBase(baseUrl),key===undefined?null:key,protocol]);
}
