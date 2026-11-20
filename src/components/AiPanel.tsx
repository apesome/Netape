import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { invoke, Channel } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { AssistantRuntimeProvider, ThreadPrimitive, MessagePrimitive, ActionBarPrimitive, useExternalStoreRuntime, type TextMessagePartProps } from "@assistant-ui/react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { redactAiContext, type AiConfig, type AiConversation, type AiMessage, type TerminalApi } from "../ai";
import { companionContext, companionMarkdown, companionProfile, companionRetry, companionModel, companionServiceKey, companionLastModel, COMPANION_LAST_MODEL_KEY } from "../aiCompanion";
import { getLang, useT } from "../i18n";
import AiCompanionModelPicker from "./AiCompanionModelPicker";
import { AiIcon, aiLabel as l } from "./AiCommon";
import { toast } from "./Toast";
import AiUsage from "./AiUsage";
import { aiNeedsApiKey } from "../aiProviders";

interface Props {
  tabId: string; scope: string; title: string; protocol: string; sessionId?: string; connected: boolean;
  visible: boolean; width: number; getTerminal: () => TerminalApi | undefined; getCwd: () => string;
  onClose: () => void; onSettings: () => void;
}
type ActionContext = { paste?: (code:string)=>void; run?: (code:string)=>void; busy:boolean };
const Actions=createContext<ActionContext>({busy:false});
const shellLanguages=new Set(["sh","bash","shell","zsh","console","powershell","ps1","cmd","bat"]);
function CodeBlock({className,children}:{className?:string;children?:ReactNode}) {
  const actions=useContext(Actions),language=/language-([\w-]+)/.exec(className??"")?.[1]??"";
  const code=String(children??"").replace(/\n$/,"");
  if(!className&&!code.includes("\n"))return <code>{children}</code>;
  const runnable=shellLanguages.has(language);
  return <div className="ai-code"><div className="ai-code-actions"><span>{language||"text"}</span>
    <button type="button" onClick={()=>void writeText(code).then(()=>toast(l("已复制","Copied"),"success")).catch(e=>toast(String(e)))}>{l("复制","Copy")}</button>
    {runnable&&actions.paste&&<button type="button" disabled={actions.busy} onClick={()=>actions.paste?.(code)}>{l("填入终端","Paste")}</button>}
    {runnable&&actions.run&&<button type="button" disabled={actions.busy} onClick={()=>actions.run?.(code)}>{l("执行…","Run…")}</button>}
  </div><pre><code>{code}</code></pre></div>;
}
const TextPart=({text}:TextMessagePartProps)=><Markdown remarkPlugins={[remarkGfm]} components={{
  code:({className,children})=><CodeBlock className={className}>{children}</CodeBlock>,
  pre:({children})=><>{children}</>,a:({children})=><span>{children}</span>,img:()=>null,
}}>{text}</Markdown>;
const UserTextPart=(props:TextMessagePartProps)=>{
  const {text}=props;
  const start=text.indexOf('\n\n<terminal_context untrusted="true">');
  if(start<0)return <TextPart {...props}/>;
  const body=text.slice(start).replace(/^\s*<terminal_context untrusted="true">\n?/,"").replace(/\n?<\/terminal_context>$/,"");
  return <><Markdown components={{img:()=>null,a:({children})=><span>{children}</span>}}>{text.slice(0,start)}</Markdown><details className="ai-shared-context"><summary>{l("已共享的终端上下文","Shared terminal context")}</summary><pre>{body}</pre></details></>;
};
const UserMessage=()=> <MessagePrimitive.Root className="ai-message ai-message--user"><span className="ai-message-label">{l("你","You")}</span><MessagePrimitive.Content components={{Text:UserTextPart}}/></MessagePrimitive.Root>;
const AssistantMessage=()=> <MessagePrimitive.Root className="ai-message ai-message--assistant"><span className="ai-message-label"><AiIcon/> Netape</span><MessagePrimitive.Content components={{Text:TextPart}}/><ActionBarPrimitive.Root className="ai-message-actions" hideWhenRunning><ActionBarPrimitive.Copy aria-label={l("复制回答","Copy response")}><PanelIcon name="copy"/>{l("复制","Copy")}</ActionBarPrimitive.Copy></ActionBarPrimitive.Root></MessagePrimitive.Root>;
function PanelIcon({name}:{name:"new"|"history"|"settings"|"close"|"copy"|"send"|"stop"|"terminal"|"expand"|"back"}) {
  const paths = {new:<path d="M12 5v14M5 12h14"/>,history:<><path d="M3 11a9 9 0 1 1 2 7M3 4v7h7"/><path d="M12 7v5l3 2"/></>,settings:<><path d="m9 3-1 3-3 1-2 4 2 3v4l4 2 3-1 3 1 4-2v-4l2-3-2-4-3-1-1-3Z"/><circle cx="12" cy="12" r="3"/></>,close:<path d="m6 6 12 12M18 6 6 18"/>,copy:<><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/></>,send:<path d="M12 19V5m-6 6 6-6 6 6"/>,stop:<rect x="6" y="6" width="12" height="12" rx="2"/>,terminal:<><rect x="3" y="4" width="18" height="16" rx="3"/><path d="m7 9 3 3-3 3m6 0h4"/></>,expand:<path d="M8 3H3v5m13-5h5v5M3 16v5h5m8 0h5v-5"/>,back:<path d="m14 5-7 7 7 7"/>};
  return <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

export default function AiPanel(props:Props){
  useT();
  const [config,setConfig]=useState<AiConfig|null>(null),[profileId,setProfileId]=useState("");
  const [modelChoices,setModelChoices]=useState<Record<string,string>>({});
  const selected=config?.profiles.find(p=>p.id===profileId);
  const model=companionModel(selected,modelChoices);
  const currentModel=useRef(model);currentModel.current=model;
  const [messages,setMessages]=useState<AiMessage[]>([]),[draft,setDraft]=useState("");
  const [tokenUsage,setTokenUsage]=useState<{input:number;output:number}|null>(null);
  const [running,setRunning]=useState(false),[error,setError]=useState("");
  const [attachment,setAttachment]=useState(""),[attachOutput,setAttachOutput]=useState(false);
  const [historyQuery,setHistoryQuery]=useState(""),[historyLoading,setHistoryLoading]=useState(false),[expanded,setExpanded]=useState(false);
  const [attachmentKind,setAttachmentKind]=useState<"selection"|"output">("output");
  const composerRef=useRef<HTMLTextAreaElement>(null),historyRevision=useRef(0);
  const [history,setHistory]=useState<AiConversation[]>([]),[showHistory,setShowHistory]=useState(false);
  const [pending,setPending]=useState<{code:string;sessionId?:string;cwd:string}|null>(null);
  const [commandOutput,setCommandOutput]=useState(""),[commandResult,setCommandResult]=useState("");
  const [commandStatus,setCommandStatus]=useState<"running"|"done"|"failed"|"cancelled">("done");
  const [interactiveCommand,setInteractiveCommand]=useState("");
  const conversationId=useRef<string>(crypto.randomUUID()),requestId=useRef<string|null>(null),commandId=useRef<string|null>(null);
  const [commandBusy,setCommandBusy]=useState(false);
  const messagesRef=useRef(messages),propsRef=useRef(props),configRef=useRef(config),mounted=useRef(true),selectedProfile=useRef(profileId);
  messagesRef.current=messages;propsRef.current=props;configRef.current=config;selectedProfile.current=profileId;
  const loadConfig=()=>invoke<AiConfig>("ai_config_get").then(c=>{
    if(!mounted.current)return;setConfig(c);setAttachOutput(c.attachOutput);
    let last:ReturnType<typeof companionLastModel>=null;
    try{last=companionLastModel(c,localStorage.getItem(COMPANION_LAST_MODEL_KEY));}catch{/* Storage can be unavailable. */}
    if(last)setModelChoices(old=>({...last.choices,...old}));
    setProfileId(old=>c.profiles.some(item=>item.id===old)?old:last?.profileId??companionProfile(c,old));
  }).catch(e=>setError(String(e)));
  const rememberModel=(profile:AiConfig["profiles"][number],value:string)=>{
    if(!value.trim())return;
    try{localStorage.setItem(COMPANION_LAST_MODEL_KEY,JSON.stringify({source:companionServiceKey(profile),model:value.trim()}));}catch{/* Keep selection usable without storage. */}
  };
  useEffect(()=>{
    mounted.current=true;void loadConfig();
    const configChanged=()=>{void loadConfig();};
    const cleared=()=>{
      for(const id of [requestId.current,commandId.current])if(id)void invoke("ai_cancel",{requestId:id});
      requestId.current=null;commandId.current=null;setRunning(false);setCommandBusy(false);setPending(null);setCommandOutput("");setCommandResult("");setCommandStatus("done");setInteractiveCommand("");setAttachment("");setHistory([]);setHistoryLoading(false);setTokenUsage(null);setMessages([]);historyRevision.current++;conversationId.current=crypto.randomUUID();
    };
    window.addEventListener("netape-ai-config",configChanged);window.addEventListener("netape-ai-history-cleared",cleared);
    return ()=>{mounted.current=false;window.removeEventListener("netape-ai-config",configChanged);window.removeEventListener("netape-ai-history-cleared",cleared);
      for(const id of [requestId.current,commandId.current])if(id)void invoke("ai_cancel",{requestId:id});};
  },[]);
  useEffect(()=>{if(!props.visible||!props.connected)setPending(null);},[props.visible,props.connected]);
  useEffect(()=>{if(config?.permission!=="confirm")setPending(null);},[config?.permission]);
  useEffect(()=>{setPending(null);setCommandOutput("");setCommandResult("");setCommandStatus("done");setInteractiveCommand("");setAttachment("");setCommandBusy(false);if(commandId.current)void invoke("ai_cancel",{requestId:commandId.current});commandId.current=null;},[props.sessionId,props.connected]);
  const loadHistory=async()=>{
    const attempt=++historyRevision.current;setHistoryLoading(true);
    try { const list=await invoke<AiConversation[]>("ai_history_list",{scope:propsRef.current.scope});
      if(mounted.current&&attempt===historyRevision.current)setHistory(list.sort((a,b)=>b.updated-a.updated));
    } catch(e) {if(mounted.current&&attempt===historyRevision.current)setError(String(e));}
    finally {if(mounted.current&&attempt===historyRevision.current)setHistoryLoading(false);}
  };
  useEffect(()=>{if(props.visible&&config)void loadHistory();},[props.visible,props.scope,config?.saveHistory]);
  const persist=async(list:AiMessage[])=>{
    if(!configRef.current?.saveHistory||!list.length)return;
    let length=0;
    const recent=list.slice(-40).map(m=>({...m,content:m.content.slice(-100000)})).reverse().filter(m=>{length+=m.content.length;return length<=120000;}).reverse();
    await invoke("ai_history_save",{conversation:{id:conversationId.current,scope:propsRef.current.scope,
      title:list.find(m=>m.role==="user")?.content.split("\n\n<terminal_context")[0].slice(0,100)??propsRef.current.title,updated:Date.now(),messages:recent.map(({role,content})=>({role,content}))}});
  };
  const stop=()=>{setPending(null);for(const id of [requestId.current,commandId.current])if(id)void invoke("ai_cancel",{requestId:id});};
  const generate=async(base:AiMessage[])=>{
    if(requestId.current||commandId.current||!configRef.current||!currentModel.current||!configRef.current.profiles.some(p=>p.id===selectedProfile.current))return;
    const id=crypto.randomUUID(),assistantId=crypto.randomUUID();requestId.current=id;setRunning(true);setPending(null);setError("");
    let answer="";setTokenUsage(null);setMessages([...base,{id:assistantId,role:"assistant",content:""}]);
    const channel=new Channel<{type:"delta";text:string}|{type:"usage";input_tokens:number;output_tokens:number}|{type:"done"}>();
    channel.onmessage=event=>{
      if(!mounted.current||requestId.current!==id)return;
      if(event.type==="usage"){setTokenUsage({input:event.input_tokens,output:event.output_tokens});return;}
      if(event.type!=="delta")return;
      answer+=event.text;setMessages([...base,{id:assistantId,role:"assistant",content:answer}]);
    };
    try{
      const recent=base.slice(-40);let length=0;
      const bounded=recent.reverse().filter(m=>{length+=m.content.length;return length<=120000;}).reverse();
      if(!bounded.length)throw Error(l("消息过长，请减少终端上下文","Message too long; reduce terminal context"));
      await invoke("ai_chat",{requestId:id,profileId:selectedProfile.current,model:currentModel.current,language:getLang(),messages:bounded.map(({role,content})=>({role,content})),onEvent:channel});
    }catch(e){if(mounted.current&&requestId.current===id&&String(e)!=="Cancelled")setError(String(e));}
    finally{
      if(mounted.current&&requestId.current===id){
        const next=answer?[...base,{id:assistantId,role:"assistant" as const,content:answer}]:base;
        setMessages(next);setRunning(false);requestId.current=null;
        void persist(next).catch(e=>setError(l("保存记录失败：","Could not save history: ")+String(e)));
      }
    }
  };
  const context=()=>{
    const p=propsRef.current,c=configRef.current;if(!c)return "";
    const output=attachOutput?redactAiContext(p.getTerminal()?.getOutput(c.contextLines)??""):"";
    return companionContext([c.attachHost?`Host: ${p.title}\nProtocol: ${p.protocol}\nDirectory: ${p.getCwd()||"unknown"}`:"",attachment,output]);
  };
  const submit=async(text:string)=>{
    if(!text.trim()||requestId.current||commandId.current||!config||!model||!config.profiles.some(p=>p.id===profileId))return;
    const attached=context();
    const content=redactAiContext(text.trim())+(attached?`\n\n<terminal_context untrusted="true">\n${attached}\n</terminal_context>`:"");
    setDraft("");setAttachment("");setShowHistory(false);await generate([...messagesRef.current,{id:crypto.randomUUID(),role:"user",content}]);
  };
  const runtime=useExternalStoreRuntime<AiMessage>({
    messages,isRunning:running,convertMessage:m=>({id:m.id,role:m.role,content:m.content}),
    onNew:async(message)=>{await submit(message.content.filter(p=>p.type==="text").map(p=>p.type==="text"?p.text:"").join("\n"));},
    onCancel:async()=>stop(),
  });
  const capture=(selection:boolean)=>{
    const term=props.getTerminal();const text=selection?term?.getSelection():term?.getOutput(config?.contextLines??100);
    if(!text?.trim()){toast(l("没有可附带的终端内容","No terminal content to attach"),"info");return;}
    setAttachment(redactAiContext(text).slice(-64000));setAttachmentKind(selection?"selection":"output");
  };
  const paste=async(code:string)=>{try{
    if(!propsRef.current.visible||!propsRef.current.connected)throw Error(l("终端未连接","Terminal is disconnected"));
    if(configRef.current?.permission==="suggest")throw Error(l("当前仅允许建议","Suggestions-only mode is enabled"));
    const terminal=propsRef.current.getTerminal();if(!terminal)throw Error(l("终端尚未就绪","Terminal is not ready"));
    await terminal.paste(code);toast(l("已填入终端，按回车执行","Pasted into terminal; press Enter to execute"),"success");
  }catch(e){toast(String(e));}};
  const run=async()=>{
    if(!pending||requestId.current||commandId.current||configRef.current?.permission!=="confirm")return;
    const p=propsRef.current;
    if(!p.visible||!p.connected||p.sessionId!==pending.sessionId){setPending(null);setError(l("终端会话已变化，请重新确认","Terminal session changed; review the command again"));return;}
    if(p.protocol!=="SSH"){
      try{const terminal=p.getTerminal();if(!terminal)throw Error("Terminal is unavailable");await terminal.execute(pending.code);setInteractiveCommand(pending.code);setPending(null);}
      catch(e){setError(String(e));}return;
    }
    const id=crypto.randomUUID();commandId.current=id;setCommandBusy(true);setCommandStatus("running");setPending(null);setCommandOutput("");setCommandResult("");
    const channel=new Channel<string>();channel.onmessage=text=>{if(mounted.current&&commandId.current===id)setCommandOutput(old=>(old+text).slice(-256000));};
    try{
      const result=await invoke<{output:string;exitCode:number;truncated:boolean}>("ai_run_ssh",{requestId:id,sessionId:pending.sessionId,command:pending.code,cwd:pending.cwd,onOutput:channel});
      if(mounted.current&&commandId.current===id){setCommandStatus(result.exitCode===0?"done":"failed");setCommandOutput(result.output);setCommandResult(`$ ${pending.code}\nDirectory: ${pending.cwd}\nExit: ${result.exitCode}${result.truncated?" (output limit reached)":""}\n${redactAiContext(result.output)}`);}
    }catch(e){if(mounted.current&&commandId.current===id){setCommandStatus(String(e)==="Cancelled"?"cancelled":"failed");if(String(e)!=="Cancelled")setError(String(e));}}finally{if(commandId.current===id){commandId.current=null;if(mounted.current)setCommandBusy(false);}}
  };
  const actions:ActionContext={busy:running||commandBusy||!props.connected,
    paste:config?.permission!=="suggest"?code=>{void paste(code);}:undefined,
    run:config?.permission==="confirm"?code=>setPending({code,sessionId:props.sessionId,cwd:props.getCwd()}):undefined};
  const missingKey=!!selected&&aiNeedsApiKey(selected);
  const configured=!!selected&&!!model&&!missingKey;
  const locked=running||commandBusy;
  const permission=config?.permission??"suggest";
  const permissionLabel=permission==="confirm"?l("逐次确认执行","Confirm each run"):permission==="paste"?l("允许填入终端","Paste to terminal"):l("仅建议","Suggestions only");
  const resetConversation=()=>{
    if(requestId.current||commandId.current)return;
    setTokenUsage(null);setMessages([]);setDraft("");setAttachment("");setPending(null);setShowHistory(false);setError("");setCommandOutput("");setCommandResult("");setCommandStatus("done");setInteractiveCommand("");
    conversationId.current=crypto.randomUUID();composerRef.current?.focus();void loadHistory();
  };
  const restoreConversation=(item:AiConversation)=>{
    if(requestId.current||commandId.current)return;
    setTokenUsage(null);conversationId.current=item.id;setMessages(item.messages.map(m=>({...m,id:crypto.randomUUID()})));setDraft("");setShowHistory(false);setPending(null);setAttachment("");setError("");setCommandOutput("");setCommandResult("");setCommandStatus("done");setInteractiveCommand("");
  };
  const retry=()=>{const base=companionRetry(messagesRef.current);if(base.length&&!locked)void generate(base);};
  const prepareTask=(kind:"explain"|"diagnose"|"command")=>{
    if(locked)return;
    const selection=props.getTerminal()?.getSelection()?.trim();
    setDraft(kind==="explain"?l("请解释这段终端内容，并说明关键步骤。","Explain this terminal content and its key steps."):kind==="diagnose"?l("请分析最近终端输出中的问题，给出排查步骤和修复建议。","Analyze the recent terminal output, diagnose the issue and suggest fixes."):l("我想完成以下操作，请给出命令并解释作用：","Help me with this task. Suggest commands and explain them: "));
    if(kind!=="command")capture(!!selection);
    composerRef.current?.focus();
  };
  const filteredHistory=history.filter(item=>item.title.toLowerCase().includes(historyQuery.toLowerCase()));
  return <aside className="ai-panel ai-companion" style={{width:props.width}} aria-label={l("AI 助手","AI assistant")}>
    <header className="ai-panel-header"><span><AiIcon/><span>{l("AI 助手","AI assistant")}</span></span><div>
      <button type="button" className="ai-header-action" disabled={locked||!messages.length} aria-label={l("复制对话","Copy conversation")} data-tooltip={l("复制对话为 Markdown","Copy conversation as Markdown")} onClick={()=>void writeText(companionMarkdown(messages,props.title)).then(()=>toast(l("对话已复制","Conversation copied"),"success")).catch(e=>toast(String(e)))}><PanelIcon name="copy"/></button>
      <button type="button" className={`ai-header-action${showHistory?" is-active":""}`} disabled={locked} onClick={()=>{setShowHistory(!showHistory);setHistoryQuery("");void loadHistory();}} aria-label={l("对话历史","Conversation history")} data-tooltip={l("对话历史","Conversation history")} aria-pressed={showHistory}><PanelIcon name="history"/></button>
      <button type="button" className="ai-header-action" disabled={locked} onClick={resetConversation} aria-label={l("新对话","New conversation")} data-tooltip={l("新对话","New conversation")}><PanelIcon name="new"/></button>
      <button type="button" className="ai-header-action" onClick={props.onSettings} aria-label={l("AI 设置","AI settings")} data-tooltip={l("AI 设置","AI settings")}><PanelIcon name="settings"/></button>
      <button type="button" className="ai-header-action" onClick={props.onClose} aria-label={l("关闭 AI 助手","Close AI assistant")}><PanelIcon name="close"/></button>
    </div></header>
    <div className="ai-companion-session"><PanelIcon name="terminal"/><span title={`${props.title} · ${props.getCwd()}`}>{props.title}<small>{props.getCwd()||props.protocol}</small></span><span className={`ai-connection-state${props.connected?" is-connected":""}`}><i/>{props.connected?props.protocol:l("未连接","Disconnected")}</span></div>
    {showHistory?<section className="ai-history-view" aria-label={l("对话历史","Conversation history")}>
      <div className="ai-history-head"><button type="button" className="ai-header-action" aria-label={l("返回对话","Back to conversation")} onClick={()=>setShowHistory(false)}><PanelIcon name="back"/></button><h3>{l("对话历史","Conversation history")}</h3><span>{history.length}</span></div>
      <input className="hf-ctrl" aria-label={l("搜索对话","Search conversations")} placeholder={l("搜索当前终端的对话…","Search this terminal’s conversations…")} value={historyQuery} onChange={e=>setHistoryQuery(e.target.value)}/>
      <div className="ai-history-items">{historyLoading?<p className="ai-muted" role="status">{l("正在读取记录…","Loading conversations…")}</p>:filteredHistory.length?filteredHistory.map(item=><button type="button" key={item.id} className={`ai-history-item${item.id===conversationId.current?" is-active":""}`} onClick={()=>restoreConversation(item)}><span>{item.title}</span><small>{new Date(item.updated).toLocaleString()} · {item.messages.length} {l("条消息","messages")}</small></button>):<div className="ai-history-empty"><PanelIcon name="history"/><p>{historyQuery?l("没有匹配的对话","No matching conversations"):l("当前终端暂无历史对话","No conversations for this terminal yet")}</p>{!config?.saveHistory&&<small>{l("本地聊天记录已在协作偏好中关闭","Local history is disabled in collaboration preferences")}</small>}</div>}</div>
    </section>:<>
    <Actions.Provider value={actions}><AssistantRuntimeProvider runtime={runtime}><ThreadPrimitive.Root className="ai-thread"><ThreadPrimitive.Viewport className="ai-messages">
      {!messages.length&&<div className="ai-empty"><div className="ai-empty-heading"><span className="ai-empty-emblem" aria-hidden="true"><AiIcon/></span><div className="ai-empty-copy"><h3>{l("一起处理终端里的事","Let’s work in your terminal")}</h3><p>{l("理解输出、排查问题，或把想法变成命令。","Understand output, troubleshoot issues, or turn an idea into commands.")}</p></div></div>
        {!selected?<div className="ai-setup-callout"><div className="ai-setup-heading"><strong>{l("先连接一个模型服务","Connect a model to get started")}</strong><button type="button" className="ai-setup-configure" onClick={props.onSettings} aria-label={l("配置模型服务","Configure model service")} data-tooltip={l("配置模型服务","Configure model service")}><PanelIcon name="settings"/></button></div><p>{l("使用 AI 设置中已配置的供应商和模型。","Use the providers and models configured in AI settings.")}</p></div>:<div className="ai-quick-tasks"><button type="button" onClick={()=>prepareTask("explain")}><PanelIcon name="terminal"/><span>{l("解释终端内容","Explain terminal content")}</span><span>↗</span></button><button type="button" onClick={()=>prepareTask("diagnose")}><PanelIcon name="history"/><span>{l("分析报错并排查","Diagnose an error")}</span><span>↗</span></button><button type="button" onClick={()=>prepareTask("command")}><PanelIcon name="new"/><span>{l("帮我编写命令","Help write a command")}</span><span>↗</span></button></div>}
        {history.length>0&&<div className="ai-recent"><div><strong>{l("最近对话","Recent conversations")}</strong><button type="button" onClick={()=>{setShowHistory(true);setHistoryQuery("");void loadHistory();}}>{l("查看全部","View all")}</button></div>{history.slice(0,3).map(item=><button type="button" key={item.id} onClick={()=>restoreConversation(item)}><span>{item.title}</span><small>{new Date(item.updated).toLocaleDateString()}</small></button>)}</div>}
      </div>}
      <ThreadPrimitive.Messages components={{UserMessage,AssistantMessage}}/>
      {running&&<p className="ai-muted ai-thinking" role="status"><i/>{l("正在回答…","Responding…")}</p>}
      {!locked&&messages[messages.length-1]?.role==="assistant"&&!error&&<button type="button" className="ai-regenerate" disabled={!configured} onClick={retry}><PanelIcon name="history"/>{l("重新回答","Regenerate response")}</button>}
    </ThreadPrimitive.Viewport>{messages.length>0&&<ThreadPrimitive.ScrollToBottom className="ai-scroll-latest" aria-label={l("滚动到最新消息","Scroll to latest message")}>↓</ThreadPrimitive.ScrollToBottom>}</ThreadPrimitive.Root></AssistantRuntimeProvider></Actions.Provider>
    {(commandBusy||commandOutput||commandResult||commandStatus==="cancelled"||commandStatus==="failed")&&<section className="ai-command-result"><div className="ai-result-heading"><PanelIcon name="terminal"/><strong>{l("独立 SSH 命令","Independent SSH command")}</strong><span className={commandBusy?"is-running":""}>{commandBusy?l("执行中","Running"):commandStatus==="cancelled"?l("已停止","Stopped"):commandStatus==="failed"?l("执行失败","Failed"):l("已完成","Completed")}</span></div><pre>{commandOutput||(commandBusy?l("等待命令输出…","Waiting for output…"):commandStatus==="cancelled"?l("命令已停止","Command stopped"):l("没有返回输出","No output returned"))}</pre>{commandBusy?<button type="button" onClick={stop}>{l("停止命令","Stop command")}</button>:commandResult&&<button type="button" disabled={running||!configured} onClick={()=>void submit(l("请分析以下命令执行结果：","Analyze this command result:")+"\n\n"+commandResult)}>{l("分析执行结果","Analyze result")}</button>}</section>}
    {interactiveCommand&&<section className="ai-command-result"><div className="ai-result-heading"><PanelIcon name="terminal"/><strong>{l("命令已提交到终端","Command submitted to terminal")}</strong></div><pre>{interactiveCommand}</pre><p className="ai-muted">{l("命令完成后，可读取最近输出继续分析。","Once the command finishes, read recent output to continue.")}</p><button type="button" disabled={locked||!configured} onClick={()=>void submit(l("请分析终端执行结果：","Analyze the terminal result:")+"\n$ "+interactiveCommand+"\n"+redactAiContext(props.getTerminal()?.getOutput(config?.contextLines??100)??""))}>{l("读取输出并分析","Read output & analyze")}</button><button type="button" aria-label={l("关闭执行结果","Dismiss command result")} onClick={()=>setInteractiveCommand("")}>×</button></section>}
    </>}
    {error&&<div className="ai-error" role="alert"><span>{error}</span><button type="button" disabled={locked||!configured||!companionRetry(messages).length} onClick={retry}>{l("重试","Retry")}</button><button type="button" aria-label={l("关闭错误提示","Dismiss error")} onClick={()=>setError("")}>×</button></div>}
    {!showHistory&&<div className={`ai-composer${expanded?" is-expanded":""}`}>
      <div className="ai-composer-card">
        {attachment&&<details className="ai-attachment"><summary><PanelIcon name="terminal"/><span>{attachmentKind==="selection"?l("终端选区","Terminal selection"):l("最近输出","Recent output")}</span><small>{attachment.split("\n").length} {l("行","lines")}</small></summary><pre>{attachment}</pre><button type="button" onClick={()=>setAttachment("")}>{l("移除附件","Remove attachment")}</button></details>}
        <textarea ref={composerRef} className="hf-ctrl" maxLength={32000} aria-label={l("发送给 AI 的消息","Message AI")} placeholder={!selected?l("先配置模型服务，再开始对话…","Configure a model service to start…"):!model?l("在下方选择模型后发送…","Select a model below before sending…"):l("提问，或描述你想完成的操作…","Ask anything or describe your task…")} value={draft} onChange={e=>setDraft(e.target.value)} rows={expanded?8:3} onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();if(!locked&&configured)void submit(draft);}}}/>
        <div className="ai-context-actions"><button type="button" disabled={locked||!props.connected} onClick={()=>capture(true)}><PanelIcon name="terminal"/>{l("选区","Selection")}</button><button type="button" disabled={locked||!props.connected} onClick={()=>capture(false)}>{l("最近输出","Recent output")}</button><label title={l("每次发送附带最新终端输出","Include fresh terminal output with each message")}><input type="checkbox" checked={attachOutput} disabled={locked} onChange={e=>setAttachOutput(e.target.checked)}/>{l("自动附带","Auto attach")}</label><button type="button" aria-label={expanded?l("收起输入框","Collapse input"):l("展开输入框","Expand input")} onClick={()=>setExpanded(!expanded)}><PanelIcon name="expand"/></button></div>
        <div className="ai-composer-bottom"><div className="ai-composer-model">{config?.profiles.length?<AiCompanionModelPicker id={`ai-provider-${props.tabId}`} profiles={config.profiles} profileId={profileId} model={model} disabled={locked} visible={props.visible} onSettings={props.onSettings} onProfileChange={id=>{setProfileId(id);const next=config.profiles.find(item=>item.id===id);if(next)rememberModel(next,companionModel(next,modelChoices));setPending(null);}} onModelChange={value=>{if(selected){setModelChoices(old=>({...old,[companionServiceKey(selected)]:value}));rememberModel(selected,value);}setPending(null);}}/>:<button type="button" className="ai-model-setup" onClick={props.onSettings}><span>{l("选择模型","Choose model")}</span><svg className="ai-model-chevron" aria-hidden="true" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="m4 6 4 4 4-4"/></svg></button>}{selected&&!!model&&selected.hasKey&&<AiUsage profile={selected} visible={props.visible} refreshSignal={running}/>}</div>
          {locked?<button type="button" className="ai-send-button is-stop" aria-label={commandBusy?l("停止命令","Stop command"):l("停止生成","Stop generation")} onClick={stop}><PanelIcon name="stop"/></button>:<button type="button" className="ai-send-button btn-primary" aria-label={l("发送消息","Send message")} disabled={!draft.trim()||!configured} onClick={()=>void submit(draft)}><PanelIcon name="send"/></button>}
        </div>
      </div>
      {tokenUsage&&<div className="ai-token-usage">{l("本次 Token：输入 ","Request tokens: input ")}{tokenUsage.input.toLocaleString()} · {l("输出 ","output ")}{tokenUsage.output.toLocaleString()}</div>}
      <div className="ai-composer-meta"><button type="button" onClick={props.onSettings} data-tooltip={l("在协作偏好中调整权限","Change permissions in collaboration preferences")}><span className={`ai-permission-dot ai-permission-dot--${permission}`}/>{permissionLabel}</button><small>{l("Enter 发送 · Shift+Enter 换行","Enter to send · Shift+Enter for newline")}</small></div>
    </div>}
    {pending&&<div className="ai-command-review" role="dialog" aria-label={l("确认执行命令","Review command")}><h3>{l("确认执行命令","Review command")}</h3><p>{props.title} · {props.protocol}</p>{props.protocol==="SSH"&&<label>{l("工作目录","Working directory")}<input className="hf-ctrl" value={pending.cwd} onChange={e=>setPending({...pending,cwd:e.target.value})}/></label>}<textarea className="hf-ctrl" rows={5} value={pending.code} onChange={e=>setPending({...pending,code:e.target.value})}/><p className="ai-muted">{props.protocol==="SSH"?l("在当前 SSH 连接的新命令通道执行，不继承终端的虚拟环境和临时变量。请检查完整命令。","Runs in a new command channel on this SSH connection. Virtual environments and temporary shell variables are not inherited. Review the full command."):l("将命令输入当前终端并回车。请确认终端处于空闲 shell 提示符，而不是密码输入或其他程序中。","Types the command and presses Enter in this terminal. Ensure it is at an idle shell prompt, not a password prompt or another application.")}</p><div><button onClick={()=>setPending(null)}>{l("取消","Cancel")}</button><button className="btn-primary" disabled={!pending.code.trim()||(props.protocol==="SSH"&&!pending.cwd.startsWith('/'))} onClick={()=>void run()}>{l("确认执行","Run command")}</button></div></div>}
  </aside>;
}
