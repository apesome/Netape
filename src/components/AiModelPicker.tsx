import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { readText } from "@tauri-apps/plugin-clipboard-manager";
import { AiProviderMark } from "./AiSettingsUi";
import { aiLabel as l } from "./AiCommon";

export default function AiModelPicker({value,models,onChange,onRefresh,refreshing,disabled}:{
  value:string;models:string[];onChange:(value:string)=>void;onRefresh:()=>void;refreshing:boolean;disabled:boolean;
}) {
  const root=useRef<HTMLDivElement>(null),input=useRef<HTMLInputElement>(null),menu=useRef<HTMLDivElement>(null);
  const [open,setOpen]=useState(false),[search,setSearch]=useState(false),[active,setActive]=useState(-1);
  const [position,setPosition]=useState({left:0,top:0,width:0,maxHeight:240});
  const id=useId(),listId=`ai-models-${id}`;
  const options=[...new Set(models)].filter(model=>!search||model.toLowerCase().includes(value.toLowerCase()));
  const show=open&&!disabled;
  useEffect(()=>{setOpen(false);setActive(-1);},[disabled]);
  useEffect(()=>{setActive(-1);},[value,models]);
  useLayoutEffect(()=>{
    if(!show)return;
    const update=()=>{
      const rect=root.current?.getBoundingClientRect();if(!rect)return;
      const below=window.innerHeight-rect.bottom-10,above=rect.top-10;
      const height=Math.min(240,Math.max(42,options.length*36+8));
      const up=below<Math.min(height,160)&&above>below;
      const maxHeight=Math.max(42,Math.min(height,up?above:below));
      setPosition({left:Math.max(8,Math.min(rect.left,window.innerWidth-rect.width-8)),top:up?rect.top-maxHeight-4:rect.bottom+4,width:rect.width,maxHeight});
    };
    update();window.addEventListener("resize",update);document.addEventListener("scroll",update,true);
    return ()=>{window.removeEventListener("resize",update);document.removeEventListener("scroll",update,true);};
  },[show,options.length]);
  useEffect(()=>{
    if(!show)return;
    const outside=(event:PointerEvent)=>{if(!root.current?.contains(event.target as Node)&&!menu.current?.contains(event.target as Node))setOpen(false);};
    document.addEventListener("pointerdown",outside);return ()=>document.removeEventListener("pointerdown",outside);
  },[show]);
  useEffect(()=>{if(active>=0)menu.current?.querySelectorAll<HTMLElement>('[role="option"]')[active]?.scrollIntoView({block:"nearest"});},[active]);
  const pick=(model:string)=>{onChange(model);setOpen(false);setActive(-1);input.current?.focus();};
  return <div className="ai-model-combobox" ref={root}>
    <input ref={input} id="ai-model-id" className="hf-ctrl" role="combobox" aria-label={l("模型 ID","Model ID")} aria-autocomplete="list"
      aria-expanded={show} aria-controls={show?listId:undefined} aria-activedescendant={show&&active>=0?`${listId}-${active}`:undefined}
      value={value} disabled={disabled} autoComplete="off" placeholder={l("输入模型 ID 或搜索模型…","Enter a model ID or search…")}
      onChange={event=>{onChange(event.target.value);setSearch(true);setOpen(true);setActive(-1);}}
      onClick={()=>{setSearch(false);setOpen(true);}} onKeyDown={event=>{
        if(event.nativeEvent.isComposing)return;
        if(event.key==="ArrowDown"||event.key==="ArrowUp"){
          event.preventDefault();setOpen(true);if(!open)setSearch(false);
          setActive(previous=>options.length?Math.max(0,Math.min(options.length-1,previous+(event.key==="ArrowDown"?1:-1))):-1);
        }else if(event.key==="Enter"&&show){event.preventDefault();if(active>=0&&options[active])pick(options[active]);else setOpen(false);}
        else if(event.key==="Escape"&&show){event.preventDefault();setOpen(false);}else if(event.key==="Tab")setOpen(false);
      }}/>
    <div className="ai-model-inline-actions">
      <button type="button" className="ai-model-action" disabled={disabled||!models.length} aria-label={l("展开模型列表","Show models")} data-tooltip={l("展开模型列表","Show models")} onClick={()=>{setSearch(false);setOpen(!open);input.current?.focus();}}>▾</button>
      <button type="button" className="ai-model-action" disabled={disabled} aria-label={l("粘贴模型 ID","Paste model ID")} data-tooltip={l("粘贴模型 ID","Paste model ID")} onClick={()=>{void readText().then(text=>{if(text.trim())onChange(text.trim());}).catch(()=>{});}}>⧉</button>
      <button type="button" disabled={disabled||refreshing} aria-label={l("刷新模型列表","Refresh models")} data-tooltip={l("刷新模型列表","Refresh models")} onClick={onRefresh} className={`ai-model-action${refreshing?" ai-refreshing":""}`}>↻</button>
    </div>
    {show&&createPortal(<div ref={menu} id={listId} className="custom-select-menu ai-model-menu" role="listbox" aria-label={l("可用模型","Available models")}
      style={{position:"fixed",left:position.left,top:position.top,width:position.width,maxHeight:position.maxHeight}}>
      {options.length?options.map((model,index)=><button type="button" id={`${listId}-${index}`} role="option" aria-selected={model===value} key={model}
        className={`custom-select-option${model===value?" is-selected":""}${active===index?" is-keyboard-active":""}`}
        onPointerMove={()=>setActive(index)} onMouseDown={event=>event.preventDefault()} onClick={()=>pick(model)}><AiProviderMark provider="custom" model={model} small/><span>{model}</span></button>)
        :<div className="ai-model-empty">{models.length?l("无匹配模型，可直接使用当前输入","No matches; you can use the typed ID"):l("可手动输入，或点击刷新获取列表","Type a model ID or refresh the list")}</div>}
    </div>,document.body)}
  </div>;
}
