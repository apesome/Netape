import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AiProfile } from "../ai";
import { companionServiceKey } from "../aiCompanion";
import { aiLabel as l } from "./AiCommon";
type Quota={percentage:number;resetAt:number;period?:string;balance?:number|null;balanceUnit?:string;spent?:boolean};
type Usage={success:boolean;data?:{quotas:Quota[];lastUpdated?:number}|null;error?:string|null};
const period=(value?:string)=>({fiveHour:l("5 小时","5 hours"),daily:l("每日","Daily"),weekly:l("每周","Weekly"),monthly:l("每月","Monthly")}[value??""]??l("额度","Quota"));
function usageError(error?:string|null) {
 if(!error)return l("暂无用量数据","No usage data available");
 if(error==="AI_USAGE_UNSUPPORTED")return l("当前服务不提供此 API Key 的余额或额度查询。","This service does not expose balance or quota with this API key.");
 if(error.includes("API key is empty"))return l("请先在 AI 设置中保存 API Key。","Save an API key in AI settings first.");
 if(error.includes("401"))return l("用量查询验证失败，请检查 API Key。","Usage authentication failed. Check the API key.");
 if(error.includes("403"))return l("当前 API Key 无权查询此套餐用量。","This API key cannot access the usage endpoint.");
 if(error.includes("retired"))return l("该区域的余额查询接口已停用。","The balance API for this region has been retired.");
 if(error.includes("No balance")||error.includes("No usage"))return l("暂无可查询的用量数据。","No usage data is available.");
 return l("暂时无法查询用量，请检查套餐权限后重试。","Usage is unavailable. Check subscription permissions and retry.");
}
export default function AiUsage({profile,visible,refreshSignal}:{profile:AiProfile;visible:boolean;refreshSignal:boolean}){
 const [result,setResult]=useState<{source:string;value:Usage}|null>(null),[busy,setBusy]=useState(false);
 const revision=useRef(0),source=companionServiceKey(profile)+String(profile.hasKey),latest=useRef(source);latest.current=source;
 const last=useRef(0),wasRunning=useRef(refreshSignal);
 const value=result?.source===source?result.value:null;
 const refresh=async()=>{const attempt=++revision.current,captured=source;setBusy(true);
  try{const value=await invoke<Usage>("ai_usage_get",{profileId:profile.id});if(attempt===revision.current&&latest.current===captured){setResult({source:captured,value});last.current=Date.now();}}
  catch{if(attempt===revision.current&&latest.current===captured)setResult({source:captured,value:{success:false,error:l("用量查询失败，请稍后重试。","Usage query failed. Try again later.")}});}
  finally{if(attempt===revision.current)setBusy(false);}};
 useEffect(()=>{setResult(null);setBusy(false);last.current=0;return()=>{revision.current++;};},[profile]);
 useEffect(()=>{if(visible&&!value&&!busy)void refresh();},[visible,source,value,busy]);
 useEffect(()=>{if(wasRunning.current&&!refreshSignal&&visible&&Date.now()-last.current>60000)void refresh();wasRunning.current=refreshSignal;},[refreshSignal]);
 const quotas=value?.success?value.data?.quotas:undefined;
 const emptyLabel=busy?l("查询中…","Loading usage…"):!profile.hasKey?l("未配置密钥","No API key"):value?.error==="AI_USAGE_UNSUPPORTED"?l("暂不支持用量查询","Usage unavailable"):value?.success?l("暂无用量数据","No usage data"):l("用量暂不可用","Usage unavailable");
 return <div className="ai-usage" aria-busy={busy}>
  <div className="ai-usage-values" role="status">
   {!busy&&quotas?.length?quotas.map((item,index)=><span key={index} title={item.resetAt>0?`${l("重置时间：","Resets: ")}${new Date(item.resetAt).toLocaleString()}`:undefined}>
    {item.balance!=null?`${item.spent?l("已用","Spent"):l("余额","Balance")} ${item.balance.toFixed(2)} ${item.balanceUnit??""}`:`${period(item.period)} ${l("剩余","remaining")} ${Math.max(0,100-item.percentage).toFixed(1)}%`}
   </span>):<span title={!busy?usageError(value?.error):undefined}>{emptyLabel}</span>}
  </div>
  <button type="button" className="ai-usage-refresh" disabled={busy} onClick={()=>void refresh()} aria-label={l("刷新用量","Refresh usage")} title={l("刷新用量","Refresh usage")}><svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 6.1A8 8 0 0 1 19.7 12M4.3 12A8 8 0 0 0 17.9 17.9"/></svg></button>
 </div>;
}
