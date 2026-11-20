import icons from "./data/aiProviderIcons.json" with {type:"json"};
const families: [RegExp,string][] = [
 [/claude|sonnet|opus|haiku/i,"claude"],[/deepseek/i,"deepseek"],[/(?:^|[/_-])(?:gpt|o[134](?:-|$))|chatgpt/i,"chatgpt"],
 [/qwen|qwq|qvq/i,"qwen"],[/gemini/i,"gemini"],[/gemma/i,"google"],[/kimi|moonshot/i,"kimi"],[/glm|zhipu/i,"glm"],[/minimax/i,"minimax"],[/grok/i,"grok"],
 [/mistral|mixtral|codestral|devstral|magistral/i,"mistral"],[/llama/i,"llama"],[/doubao|seed-/i,"bytedance"],[/mimo/i,"xiaomi"],[/hunyuan/i,"hunyuan"],[/ernie/i,"ernie"],[/step/i,"stepfun"],[/longcat/i,"longcat"],[/command-/i,"cohere"],[/sonar/i,"perplexity"],[/nemotron/i,"nemotron"],[/granite/i,"granite"],[/phi-/i,"phi"],[/internlm/i,"internlm"],[/minicpm/i,"minicpm"],[/yi-/i,"yi"]
];
export function aiIcon(provider:string,model?:string):string|null {
 const name=(model?families.find(([rule])=>rule.test(model))?.[1]:undefined)??(icons as Record<string,string>)[provider];
 return name?`/icons/models/${name}.${name==="meta"?"png":"svg"}`:null;
}
