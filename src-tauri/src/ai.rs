//! AI requests stay in Rust; public profiles never contain API keys.
use std::{collections::HashMap, sync::{Mutex, OnceLock}, time::Duration};
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{ipc::Channel, State};
use tokio::sync::watch;
use crate::{app_state::AppState, ssh_terminal::SshTerminalState};

const CONFIG_KEY: &str = "Setting.AI.config";
const HISTORY_KEY: &str = "AI.conversations";

fn system_prompts() -> &'static HashMap<String, String> {
    static PROMPTS: OnceLock<HashMap<String, String>> = OnceLock::new();
    PROMPTS.get_or_init(|| serde_json::from_str(include_str!("../../src/aiSystemPrompts.json")).expect("valid built-in AI prompts"))
}
fn automatic_system_prompt(prompt: &str) -> bool {
    prompt.trim().is_empty() || system_prompts().get("legacy").is_some_and(|legacy| legacy == prompt)
}
fn resolved_system_prompt(config: &Config, language: &str) -> String {
    if !automatic_system_prompt(&config.system_prompt) { return config.system_prompt.clone(); }
    system_prompts().get(language).filter(|_| language != "legacy")
        .unwrap_or(&system_prompts()["en"]).clone()
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub id: String, pub name: String, pub base_url: String, pub model: String,
    #[serde(default)] pub has_key: bool,
    #[serde(default = "default_protocol")] pub protocol: String,
    #[serde(default)] pub provider_id: Option<String>,
    #[serde(default)] pub edition_id: Option<String>,
}
pub(crate) fn default_protocol() -> String { "openai".into() }
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    pub profiles: Vec<Profile>, pub active_profile: String, pub system_prompt: String,
    pub max_tokens: u32, pub timeout_secs: u64, pub context_lines: usize,
    pub attach_output: bool, pub attach_host: bool, pub permission: String, pub save_history: bool,
}
impl Default for Config {
    fn default() -> Self { Self {
        profiles: Vec::new(),
        active_profile: String::new(), system_prompt: String::new(),
        max_tokens: 4096, timeout_secs: 120, context_lines: 100, attach_output: false, attach_host: true,
        permission: "paste".into(), save_history: true,
    }}
}
fn credential(id: &str) -> Result<keyring::Entry, String> {
    if id.is_empty() || id.len() > 100 || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') { return Err("Invalid profile ID".into()); }
    keyring::Entry::new("Netape.AI", id).map_err(|_| "System credential store is unavailable".into())
}
pub(crate) fn api_key(id: &str) -> Result<Option<String>, String> {
    match credential(id)?.get_password() {
        Ok(key) => Ok(Some(key)), Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("Cannot read API key from the system credential store".into()),
    }
}
fn is_legacy_starter(profile: &Profile) -> bool {
    profile.id == "default" && profile.name == "OpenAI compatible"
        && profile.base_url.trim_end_matches('/') == "https://api.openai.com/v1"
        && profile.model.trim().is_empty()
}
fn discard_empty_starter(config: &mut Config, has_stored_key: bool) {
    if has_stored_key { return; }
    let old_len = config.profiles.len();
    config.profiles.retain(|profile| !is_legacy_starter(profile));
    if config.profiles.len() != old_len && config.active_profile == "default" {
        config.active_profile = config.profiles.first().map(|profile| profile.id.clone()).unwrap_or_default();
    }
}
pub(crate) fn load_config(state: &AppState) -> Result<Config, String> {
    let mut config: Config = state.store.get_setting(CONFIG_KEY).map_err(|e| e.to_string())?
        .map(|s| serde_json::from_str(&s).map_err(|e| e.to_string())).unwrap_or_else(|| Ok(Config::default()))?;
    // Remove only the untouched starter from older versions. Preserve configured
    // profiles and any starter with an actual credential in the system vault.
    if config.profiles.iter().any(is_legacy_starter) {
        discard_empty_starter(&mut config, api_key("default")?.is_some());
    }
    if automatic_system_prompt(&config.system_prompt) { config.system_prompt.clear(); }
    Ok(config)
}
fn validate(config: &Config) -> Result<(), String> {
    if config.profiles.len() > 20 { return Err("Configure at most 20 profiles".into()); }
    let mut ids = std::collections::HashSet::new();
    for profile in &config.profiles {
        credential(&profile.id)?;
        if !ids.insert(&profile.id) { return Err("Duplicate profile ID".into()); }
        crate::ai_catalog::normalized_base(&profile.base_url)?;
        if !["", "openai", "anthropic"].contains(&profile.protocol.as_str()) { return Err("Invalid AI protocol".into()); }
        if profile.name.len() > 100 || profile.model.len() > 200 { return Err("Profile name or model is too long".into()); }
    }
    let valid_selection = if config.profiles.is_empty() { config.active_profile.is_empty() } else { ids.contains(&config.active_profile) };
    if !valid_selection || !(128..=32768).contains(&config.max_tokens)
        || !(10..=600).contains(&config.timeout_secs) || !(10..=2000).contains(&config.context_lines)
        || config.system_prompt.len() > 32000 || !["suggest", "paste", "confirm"].contains(&config.permission.as_str()) {
        return Err("Invalid AI settings".into());
    }
    Ok(())
}
#[tauri::command]
pub fn ai_config_get(state: State<'_, AppState>) -> Result<Config, String> {
    let mut config = load_config(&state)?;
    for profile in &mut config.profiles { profile.has_key = api_key(&profile.id)?.is_some(); }
    Ok(config)
}
#[tauri::command]
pub fn ai_config_save(mut config: Config, keys: HashMap<String, String>, state: State<'_, AppState>, ai: State<'_, AiState>) -> Result<(), String> {
    let _lock = ai.history_lock.lock().unwrap();
    validate(&config)?;
    let previous = load_config(&state)?;
    // A changed endpoint must not silently receive the old endpoint's saved credential.
    for profile in &mut config.profiles {
        profile.base_url = crate::ai_catalog::normalized_base(&profile.base_url)?;
        if let Some(old) = previous.profiles.iter().find(|old| old.id == profile.id) {
            if (crate::ai_catalog::normalized_base(&old.base_url)? != profile.base_url || old.protocol != profile.protocol)
                && !keys.contains_key(&profile.id) && api_key(&profile.id)?.is_some() {
                return Err("Endpoint changed: enter a key for the new endpoint or explicitly remove the stored credential".into());
            }
        }
    }
    for (id, key) in keys {
        if !config.profiles.iter().any(|p| p.id == id) { return Err("Unknown credential profile".into()); }
        if key.contains(['\r', '\n']) || key.len() > 8192 { return Err("Invalid API key".into()); }
        let entry = credential(&id)?;
        if key.is_empty() {
            match entry.delete_credential() { Ok(()) | Err(keyring::Error::NoEntry) => (), Err(_) => return Err("Cannot remove API key".into()) }
        } else { entry.set_password(&key).map_err(|_| "Cannot save API key to the system credential store")?; }
    }
    for p in &mut config.profiles { p.has_key = false; }
    state.store.set_setting(CONFIG_KEY, &serde_json::to_string(&config).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    if !config.save_history { state.store.set_setting(HISTORY_KEY, "[]").map_err(|e| e.to_string())?; }
    for old in previous.profiles.iter().filter(|old| !config.profiles.iter().any(|p| p.id == old.id)) {
        match credential(&old.id)?.delete_credential() { Ok(()) | Err(keyring::Error::NoEntry) => (), Err(_) => return Err("Profile saved, but its removed credential could not be deleted".into()) }
    }
    Ok(())
}
fn profile(config: &Config, id: &str) -> Result<Profile, String> {
    config.profiles.iter().find(|p| p.id == id).cloned().ok_or_else(|| "AI profile not found".into())
}
pub(crate) fn chat_body(profile: &Profile, messages: &[ChatMessage], max_tokens: u32, stream: bool) -> Value {
    if profile.protocol == "anthropic" {
        let system = messages.iter().filter(|m| m.role == "system").map(|m| m.content.as_str()).collect::<Vec<_>>().join("\n\n");
        let conversation: Vec<_> = messages.iter().filter(|m| m.role != "system").collect();
        return json!({"model":profile.model,"messages":conversation,"system":system,"max_tokens":max_tokens,"stream":stream});
    }
    let mut body = json!({"model":profile.model,"messages":messages,"stream":stream});
    if stream {body["stream_options"]=json!({"include_usage":true});}
    let modern = ["gpt-5", "o1", "o3", "o4"].iter().any(|prefix| profile.model.starts_with(prefix));
    body[if modern { "max_completion_tokens" } else { "max_tokens" }] = max_tokens.into(); body
}
pub(crate) fn api_url(profile: &Profile, path: &str) -> Result<String, String> {
    let mut base = crate::ai_catalog::normalized_base(&profile.base_url)?;
    let url = reqwest::Url::parse(&base).map_err(|_| "AI_INVALID_URL")?;
    let local_proxy = matches!(url.host_str(), Some("localhost" | "127.0.0.1")) && url.path().ends_with("/anthropic");
    if profile.protocol == "anthropic" && !base.ends_with("/v1") && !local_proxy { base.push_str("/v1"); }
    let path = if profile.protocol == "anthropic" && path == "chat/completions" { "messages" } else { path };
    Ok(format!("{base}/{path}"))
}
pub(crate) fn authorize(request: reqwest::RequestBuilder, key: &str, protocol: &str) -> reqwest::RequestBuilder {
    if protocol == "anthropic" {
        let request = request.header("anthropic-version", "2023-06-01");
        if key.is_empty() { request } else { request.header("x-api-key", key) }
    } else if key.is_empty() { request } else { request.bearer_auth(key) }
}
pub(crate) fn response_text(value: &Value, protocol: &str) -> Option<String> {
    if protocol == "anthropic" {
        let text: String = value["content"].as_array()?.iter().filter(|v| v["type"] == "text").filter_map(|v|v["text"].as_str()).collect();
        if text.is_empty() { None } else { Some(text) }
    } else { value["choices"][0]["message"]["content"].as_str().map(str::to_owned) }
}
fn request(profile: &Profile, path: &str, timeout: u64) -> Result<reqwest::RequestBuilder, String> {
    let client = reqwest::Client::builder().timeout(Duration::from_secs(timeout))
        .redirect(reqwest::redirect::Policy::none()).build().map_err(|_| "Cannot create HTTP client")?;
    let request = client.request(if path == "models" { reqwest::Method::GET } else { reqwest::Method::POST }, api_url(profile,path)?);
    Ok(authorize(request, &api_key(&profile.id)?.unwrap_or_default(), &profile.protocol))
}
async fn check_response(response: reqwest::Response) -> Result<reqwest::Response, String> {
    if response.status().is_success() { return Ok(response); }
    // Do not echo provider response bodies: proxies may put credentials in errors.
    Err(format!("AI API returned HTTP {}. Check API URL, model and credentials.", response.status().as_u16()))
}
#[tauri::command]
pub async fn ai_models(profile_id: String, state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let config = load_config(&state)?;
    let profile = profile(&config, &profile_id)?;
    Ok(crate::ai_catalog::discover(&profile,&api_key(&profile.id)?.unwrap_or_default(),config.timeout_secs).await?.models)
}
#[tauri::command]
pub async fn ai_test(profile_id: String, state: State<'_, AppState>) -> Result<String, String> {
    let config = load_config(&state)?;
    let profile = profile(&config, &profile_id)?;
    if profile.model.trim().is_empty() { return Err("Select a model first".into()); }
    let response = request(&profile, "chat/completions", config.timeout_secs)?.json(&chat_body(&profile,
        &[ChatMessage {role:"user".into(),content:"Reply with OK".into()}], 128, false))
        .send().await.map_err(|_| "Cannot connect to AI API")?;
    let value: Value = check_response(response).await?.json().await.map_err(|_| "Invalid chat response")?;
    response_text(&value, &profile.protocol).ok_or_else(|| "Model returned no text".into())
}

#[derive(Default)]
pub struct AiState { jobs: Mutex<HashMap<String, watch::Sender<bool>>>, cancelled: Mutex<std::collections::HashSet<String>>, history_lock: Mutex<()> }
struct Job<'a> { state: &'a AiState, id: String }
impl Drop for Job<'_> { fn drop(&mut self) { self.state.jobs.lock().unwrap().remove(&self.id); } }
fn job(state: &AiState, id: String) -> Result<(Job<'_>, watch::Receiver<bool>), String> {
    let mut jobs = state.jobs.lock().unwrap();
    if jobs.contains_key(&id) || jobs.len() >= 16 { return Err("Too many active AI requests".into()); }
    let cancelled = state.cancelled.lock().unwrap().remove(&id);
    let (tx, rx) = watch::channel(cancelled); jobs.insert(id.clone(), tx); Ok((Job {state,id},rx))
}
#[tauri::command]
pub fn ai_cancel(request_id: String, ai: State<'_, AiState>) {
    if let Some(tx) = ai.jobs.lock().unwrap().get(&request_id) { let _ = tx.send(true); }
    else { let mut pending = ai.cancelled.lock().unwrap(); if pending.len() > 128 { pending.clear(); } pending.insert(request_id); }
}
#[derive(Clone, Serialize, Deserialize)]
pub struct ChatMessage { pub role: String, pub content: String }
#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum StreamEvent { Delta { text: String }, Usage { input_tokens:u64, output_tokens:u64 }, Done }

/// Byte-based SSE framing: retain partial UTF-8 until a complete newline arrives.
#[derive(Default)]
struct SseDecoder { buffer: Vec<u8>, data: Vec<String> }
impl SseDecoder {
    fn push(&mut self, bytes: &[u8]) -> Result<Vec<String>, String> {
        self.buffer.extend_from_slice(bytes);
        if self.buffer.len() > 2_000_000 { return Err("AI stream record is too large".into()); }
        let mut events = Vec::new();
        while let Some(end) = self.buffer.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = self.buffer.drain(..=end).collect();
            let line = std::str::from_utf8(&line).map_err(|_| "Invalid UTF-8 in AI stream")?.trim_end_matches(['\r','\n']);
            if line.is_empty() {
                if !self.data.is_empty() { events.push(self.data.join("\n")); self.data.clear(); }
            } else if let Some(data) = line.strip_prefix("data:") {
                if self.data.iter().map(String::len).sum::<usize>() + data.len() > 2_000_000 { return Err("AI event is too large".into()); }
                self.data.push(data.strip_prefix(' ').unwrap_or(data).to_owned());
            }
        }
        Ok(events)
    }
}
fn delta(data: &str) -> Result<Option<String>, String> {
    let value: Value = serde_json::from_str(data).map_err(|_| "Invalid AI stream response")?;
    if value.get("error").is_some() { return Err("AI provider reported a streaming error".into()); }
    if value["choices"][0]["finish_reason"] == "content_filter" { return Err("AI provider filtered this response".into()); }
    if value["type"] == "content_block_delta" { return Ok(value["delta"]["text"].as_str().map(str::to_owned)); }
    if value["type"] == "content_block_start" { return Ok(value["content_block"]["text"].as_str().map(str::to_owned)); }
    Ok(value["choices"][0]["delta"]["content"].as_str().map(str::to_owned))
}
fn stream_usage(value:&Value,previous_input:u64,previous_output:u64)->Option<(u64,u64)> {
    let usage=if value["type"]=="message_start" {&value["message"]["usage"]} else {&value["usage"]};
    if !usage.is_object(){return None;}
    let input=usage["input_tokens"].as_u64().map(|v|v.saturating_add(usage["cache_creation_input_tokens"].as_u64().unwrap_or(0)).saturating_add(usage["cache_read_input_tokens"].as_u64().unwrap_or(0)))
        .or_else(||usage["prompt_tokens"].as_u64()).unwrap_or(previous_input);
    let output=usage["output_tokens"].as_u64().or_else(||usage["completion_tokens"].as_u64()).unwrap_or(previous_output);
    Some((input,output))
}
async fn consume_stream(response: reqwest::Response, on_event: impl Fn(StreamEvent) -> Result<(), String>) -> Result<(), String> {
    let mut stream = response.bytes_stream(); let mut decoder = SseDecoder::default(); let mut size = 0; let mut finished = false; let mut input_tokens=0;let mut output_tokens=0;
    while let Some(chunk) = stream.next().await {
        for data in decoder.push(&chunk.map_err(|_| "AI stream disconnected")?)? {
            if data == "[DONE]" { on_event(StreamEvent::Done)?; return Ok(()); }
            if let Some(text) = delta(&data)? {
                size += text.len(); if size > 2_000_000 { return Err("AI response exceeded limit".into()); }
                on_event(StreamEvent::Delta {text})?;
            }
            let value: Value = serde_json::from_str(&data).map_err(|_| "Invalid AI stream")?;
            if let Some((input,output))=stream_usage(&value,input_tokens,output_tokens) {
                input_tokens=input;output_tokens=output;
                on_event(StreamEvent::Usage{input_tokens,output_tokens})?;
            }
            if value["type"] == "message_stop" { on_event(StreamEvent::Done)?; return Ok(()); }
            finished |= value["choices"][0]["finish_reason"].as_str().is_some();
        }
    }
    if finished { on_event(StreamEvent::Done) } else { Err("AI stream ended before completion; retry the request".into()) }
}
fn chat_profile(config: &Config, id: &str, model: Option<String>) -> Result<Profile, String> {
    let mut selected = profile(config, id)?;
    let model = model.as_deref().unwrap_or(&selected.model).trim();
    if model.is_empty() { return Err("Select a model in AI assistant before sending".into()); }
    if model.len() > 200 || model.chars().any(char::is_control) { return Err("AI_INVALID_MODEL".into()); }
    selected.model = model.to_owned();
    Ok(selected)
}
#[tauri::command]
pub async fn ai_chat(request_id: String, profile_id: String, messages: Vec<ChatMessage>, on_event: Channel<StreamEvent>, language: Option<String>, model: Option<String>, state: State<'_, AppState>, ai: State<'_, AiState>) -> Result<(), String> {
    let config = load_config(&state)?;
    let profile = chat_profile(&config, &profile_id, model)?;
    if messages.len() > 100 || messages.iter().map(|m| m.content.len()).sum::<usize>() > 512_000
        || messages.iter().any(|m| !["user","assistant"].contains(&m.role.as_str())) { return Err("AI conversation is too large or has invalid roles".into()); }
    let (_guard, mut cancel) = job(&ai, request_id)?;
    if *cancel.borrow() { return Err("Cancelled".into()); }
    let configured_language = state.store.get_setting("Setting.Appearance.language").map_err(|e| e.to_string())?;
    let language = language.as_deref().or(configured_language.as_deref()).unwrap_or("en");
    let mut all = vec![ChatMessage {role:"system".into(),content:resolved_system_prompt(&config, language)}]; all.extend(messages);
    let future = async {
        let response = request(&profile, "chat/completions", config.timeout_secs)?.json(&chat_body(&profile,&all,config.max_tokens,true))
            .send().await.map_err(|_| "AI request failed or timed out")?;
        let response = check_response(response).await?;
        consume_stream(response, |event| on_event.send(event).map_err(|_| "Chat view closed".into())).await
    };
    tokio::select! { result = future => result, _ = cancel.changed() => Err("Cancelled".into()) }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Conversation { pub id: String, pub scope: String, pub title: String, pub updated: u64, pub messages: Vec<ChatMessage> }
fn histories(state: &AppState) -> Result<Vec<Conversation>, String> {
    let raw = state.store.get_setting(HISTORY_KEY).map_err(|e| e.to_string())?.unwrap_or_else(|| "[]".into());
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}
#[tauri::command]
pub fn ai_history_list(scope: String, state: State<'_, AppState>) -> Result<Vec<Conversation>, String> {
    if !load_config(&state)?.save_history { return Ok(Vec::new()); }
    Ok(histories(&state)?.into_iter().filter(|h| h.scope == scope).collect())
}
#[tauri::command]
pub fn ai_history_save(conversation: Conversation, state: State<'_, AppState>, ai: State<'_, AiState>) -> Result<(), String> {
    let _lock = ai.history_lock.lock().unwrap();
    if !load_config(&state)?.save_history { return Ok(()); }
    if conversation.id.len() > 100 || conversation.scope.len() > 300 || conversation.title.len() > 300 || conversation.messages.len() > 100
        || conversation.messages.iter().any(|m| !["user","assistant"].contains(&m.role.as_str()))
        || conversation.messages.iter().map(|m| m.content.len()).sum::<usize>() > 512_000 { return Err("Conversation exceeds storage limit".into()); }
    let mut list = histories(&state)?; list.retain(|h| h.id != conversation.id); list.insert(0, conversation); list.truncate(50);
    state.store.set_setting(HISTORY_KEY, &serde_json::to_string(&list).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}
#[tauri::command]
pub fn ai_history_clear(state: State<'_, AppState>, ai: State<'_, AiState>) -> Result<(), String> {
    let _lock = ai.history_lock.lock().unwrap(); state.store.set_setting(HISTORY_KEY, "[]").map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandResult { pub output: String, pub exit_code: i32, pub truncated: bool }
pub fn shell_quote(value: &str) -> String { format!("'{}'", value.replace('\'', "'\\''")) }
#[tauri::command]
pub async fn ai_run_ssh(request_id: String, session_id: String, command: String, cwd: String, on_output: Channel<String>, state: State<'_, AppState>, ai: State<'_, AiState>, ssh: State<'_, SshTerminalState>) -> Result<CommandResult, String> {
    let config = load_config(&state)?;
    if config.permission != "confirm" { return Err("Command execution is disabled in AI settings".into()); }
    if command.trim().is_empty() || command.len() > 32000 || command.contains('\0') || cwd.contains('\0') || !cwd.starts_with('/') { return Err("Command and absolute working directory are required".into()); }
    let session = ssh.clone_ssh(&session_id).ok_or("Terminal session is no longer connected")?;
    let (_guard, cancel) = job(&ai, request_id)?;
    if *cancel.borrow() { return Err("Cancelled".into()); }
    let command = format!("cd -- {} && sh -c {}", shell_quote(&cwd), shell_quote(&command));
    let result = session.exec_monitored(&command, config.timeout_secs, cancel, |text| { let _ = on_output.send(text.to_owned()); }).await.map_err(|e| e.to_string())?;
    Ok(CommandResult {output:result.stdout,exit_code:result.exit_code,truncated:result.truncated})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn usage_handles_openai_anthropic_and_missing_fields() {
        assert_eq!(stream_usage(&json!({"usage":{"prompt_tokens":100,"completion_tokens":24}}),0,0),Some((100,24)));
        assert_eq!(stream_usage(&json!({"type":"message_start","message":{"usage":{"input_tokens":10,"cache_read_input_tokens":50,"cache_creation_input_tokens":20,"output_tokens":1}}}),0,0),Some((80,1)));
        assert_eq!(stream_usage(&json!({"type":"message_delta","usage":{"output_tokens":20}}),80,1),Some((80,20)));
        assert_eq!(stream_usage(&json!({"usage":{"prompt_tokens":0,"completion_tokens":0}}),80,1),Some((0,0)));
        assert_eq!(stream_usage(&json!({"choices":[]}),0,0),None);
    }
    #[test] fn automatic_prompts_follow_language_and_keep_custom_instructions() {
        let config = Config::default();
        for (language, phrase) in [("zh_CN", "请用中文回答"), ("en", "Reply in English"), ("de", "Antworte auf Deutsch"), ("ja", "日本語で回答")] {
            assert!(resolved_system_prompt(&config, language).contains(phrase));
        }
        assert_eq!(resolved_system_prompt(&config, "unknown"), system_prompts()["en"]);
        assert_eq!(resolved_system_prompt(&config, "legacy"), system_prompts()["en"]);
        let legacy = Config { system_prompt: system_prompts()["legacy"].clone(), ..Config::default() };
        assert_eq!(resolved_system_prompt(&legacy, "zh_CN"), system_prompts()["zh_CN"]);
        let custom = Config { system_prompt: "My custom instructions. 用中文解释。".into(), ..Config::default() };
        for language in ["zh_CN", "en", "de", "ja"] { assert_eq!(resolved_system_prompt(&custom, language), custom.system_prompt); }
        let custom_english = Config { system_prompt: system_prompts()["en"].clone(), ..Config::default() };
        assert_eq!(resolved_system_prompt(&custom_english, "ja"), system_prompts()["en"]);
    }
    #[test] fn sse_handles_split_unicode_comments_crlf_and_multiple_events() {
        let mut decoder = SseDecoder::default();
        let bytes = "data: {\"choices\":[{\"delta\":{\"content\":\"你好\"}}]}\r\n\r\n: heartbeat\n\ndata: [DONE]\n\n".as_bytes();
        let mut events=Vec::new(); for byte in bytes { events.extend(decoder.push(&[*byte]).unwrap()); }
        assert_eq!(delta(&events[0]).unwrap(),Some("你好".into())); assert_eq!(events[1],"[DONE]");
        assert!(delta("{\"error\":{\"message\":\"secret\"}}").unwrap_err().contains("streaming error"));
    }
    #[test] fn anthropic_body_urls_auth_and_legacy_profile() {
        let old: Profile = serde_json::from_value(json!({"id":"old","name":"Old","baseUrl":"https://api.example.com/v1","model":"model"})).unwrap();
        assert_eq!(old.protocol,"openai");
        let mut p = Profile {protocol:"anthropic".into(),base_url:"https://api.anthropic.com".into(),..old};
        assert_eq!(api_url(&p,"chat/completions").unwrap(),"https://api.anthropic.com/v1/messages");
        p.base_url="https://api.deepseek.com/anthropic".into();
        assert_eq!(api_url(&p,"chat/completions").unwrap(),"https://api.deepseek.com/anthropic/v1/messages");
        let body=chat_body(&p,&[ChatMessage{role:"system".into(),content:"instructions".into()},ChatMessage{role:"user".into(),content:"Hi".into()}],128,true);
        assert_eq!(body["system"],"instructions");assert_eq!(body["messages"].as_array().unwrap().len(),1);assert_eq!(body["max_tokens"],128);
        let request=authorize(reqwest::Client::new().post(api_url(&p,"chat/completions").unwrap()),"test-key","anthropic").build().unwrap();
        assert_eq!(request.headers()["x-api-key"],"test-key");assert_eq!(request.headers()["anthropic-version"],"2023-06-01");assert!(!request.headers().contains_key("authorization"));
        assert_eq!(response_text(&json!({"content":[{"type":"thinking","thinking":"private"},{"type":"text","text":"OK"}]}),"anthropic"),Some("OK".into()));
        assert_eq!(delta(r#"{"type":"content_block_delta","delta":{"type":"text_delta","text":"你好"}}"#).unwrap(),Some("你好".into()));
    }
    #[tokio::test] async fn anthropic_stream_requires_message_stop() {
        use std::io::{Read,Write};
        let listener=std::net::TcpListener::bind("127.0.0.1:0").unwrap();let address=listener.local_addr().unwrap();
        let server=std::thread::spawn(move|| {
            for tail in ["data: {\"type\":\"message_stop\"}\n\n", "", "data: {\"type\":\"error\",\"error\":{\"message\":\"SECRET\"}}\n\n"] {
                let (mut socket,_)=listener.accept().unwrap();let mut buf=[0;4096];socket.read(&mut buf).unwrap();
                let body=format!("data: {{\"type\":\"content_block_delta\",\"delta\":{{\"type\":\"text_delta\",\"text\":\"你好\"}}}}\n\n{tail}");
                write!(socket,"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
            }
        });
        for index in 0..3 {
            let response=reqwest::get(format!("http://{address}/v1/messages")).await.unwrap();
            let text=Mutex::new(String::new());let done=Mutex::new(false);
            let result=consume_stream(response,|event|{match event{StreamEvent::Delta{text:part}=>text.lock().unwrap().push_str(&part),StreamEvent::Done=>*done.lock().unwrap()=true,StreamEvent::Usage{..}=>{}};Ok(())}).await;
            assert_eq!(*text.lock().unwrap(),"你好");
            if index==0 {assert!(result.is_ok());assert!(*done.lock().unwrap());} else {assert!(result.is_err());assert!(!*done.lock().unwrap());assert!(!result.unwrap_err().contains("SECRET"));}
        }
        server.join().unwrap();
    }
    #[test] fn validates_profiles_and_quotes_shell_directories() {
        let mut c=Config::default(); assert!(validate(&c).is_ok());
        assert!(c.profiles.is_empty());
        c.active_profile="provider".into(); assert!(validate(&c).is_err());
        c.profiles.push(Profile { id:"provider".into(), name:"Configured model".into(), base_url:"https://api.example.com/v1".into(), model:"model-id".into(), has_key:false, protocol:"openai".into(),provider_id:None,edition_id:None });
        assert!(validate(&c).is_ok());
        c.profiles[0].base_url="https://key:secret@example.com".into(); assert!(validate(&c).is_err());
        assert_eq!(shell_quote("/tmp/a'b"),"'/tmp/a'\\''b'");
    }
    #[test] fn service_default_model_is_optional_and_chat_override_is_transient() {
        let service = Profile { id:"service".into(),name:"Service".into(),base_url:"https://api.example.com/v1".into(),model:String::new(),has_key:false,protocol:"openai".into(),provider_id:None,edition_id:None };
        let mut config = Config { profiles:vec![service],active_profile:"service".into(),..Config::default() };
        assert!(validate(&config).is_ok());
        assert!(chat_profile(&config,"service",None).is_err());
        let selected=chat_profile(&config,"service",Some("  runtime-model  ".into())).unwrap();
        assert_eq!(selected.model,"runtime-model");
        assert_eq!(chat_body(&selected,&[],128,false)["model"],"runtime-model");
        assert!(config.profiles[0].model.is_empty());
        for model in ["".into()," ".into(),"m".repeat(201),"model\nother".into()] { assert!(chat_profile(&config,"service",Some(model)).is_err()); }
        assert!(chat_profile(&config,"unknown",Some("model".into())).is_err());
        config.profiles[0].model="default-model".into();
        assert_eq!(chat_profile(&config,"service",None).unwrap().model,"default-model");
        assert_eq!(chat_profile(&config,"service",Some("override".into())).unwrap().model,"override");
        assert_eq!(config.profiles[0].model,"default-model");
    }
    #[test] fn removes_only_untouched_starters_without_credentials() {
        let starter = Profile { id:"default".into(), name:"OpenAI compatible".into(), base_url:"https://api.openai.com/v1".into(), model:String::new(), has_key:false, protocol:"openai".into(),provider_id:None,edition_id:None };
        let mut config = Config { profiles:vec![starter.clone()], active_profile:"default".into(), ..Config::default() };
        discard_empty_starter(&mut config, true);
        assert_eq!(config.profiles.len(), 1);
        discard_empty_starter(&mut config, false);
        assert!(config.profiles.is_empty()); assert!(config.active_profile.is_empty()); assert!(validate(&config).is_ok());
        let configured = Profile { model:"gpt-4.1".into(), ..starter.clone() };
        config.profiles = vec![configured]; config.active_profile="default".into();
        discard_empty_starter(&mut config, false); assert_eq!(config.profiles.len(), 1);
        let named = Profile { name:"My connection".into(), ..starter.clone() };
        config.profiles = vec![named.clone()];
        discard_empty_starter(&mut config, false); assert_eq!(config.profiles.len(), 1);
        config.profiles = vec![starter, Profile { id:"custom".into(), ..named }];
        discard_empty_starter(&mut config, false);
        assert_eq!(config.profiles.len(), 1); assert_eq!(config.active_profile, "custom");
    }
    #[test] fn cancels_jobs_and_removes_them_on_drop() {
        let state=AiState::default();
        let (guard,rx)=job(&state,"test".into()).unwrap();
        assert!(job(&state,"test".into()).is_err());
        state.jobs.lock().unwrap()["test"].send(true).unwrap();
        assert!(*rx.borrow());drop(guard);assert!(state.jobs.lock().unwrap().is_empty());
        state.cancelled.lock().unwrap().insert("early".into());
        let (_guard,rx)=job(&state,"early".into()).unwrap();assert!(*rx.borrow());
    }
    #[tokio::test]
    async fn streams_from_compatible_http_api_and_reports_http_errors_without_body() {
        use std::io::{Read,Write};
        let listener=std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address=listener.local_addr().unwrap();
        let server=std::thread::spawn(move || {
            for (status,body) in [("200 OK","data: {\"choices\":[{\"delta\":{\"content\":\"你好\"}}]}\n\ndata: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n"),
                ("401 Unauthorized","SECRET_SHOULD_NOT_APPEAR")] {
                let (mut socket,_)=listener.accept().unwrap();let mut request=Vec::new();
                loop {
                    let mut bytes=[0;4096];let count=socket.read(&mut bytes).unwrap();if count==0{break;}request.extend_from_slice(&bytes[..count]);
                    if let Some(end)=request.windows(4).position(|w|w==b"\r\n\r\n") {
                        let headers=String::from_utf8_lossy(&request[..end]).to_lowercase();
                        let length=headers.lines().find_map(|line|line.strip_prefix("content-length:").and_then(|v|v.trim().parse::<usize>().ok())).unwrap_or(0);
                        if request.len()>=end+4+length{break;}
                    }
                }
                write!(socket,"HTTP/1.1 {status}\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",body.len()).unwrap();
                for byte in body.as_bytes() {socket.write_all(&[*byte]).unwrap();}
            }
        });
        let client=reqwest::Client::new();
        let response=client.post(format!("http://{address}/v1/chat/completions")).json(&json!({"stream":true})).send().await.unwrap();
        let text=Mutex::new(String::new());
        consume_stream(check_response(response).await.unwrap(),|event|{if let StreamEvent::Delta {text:part}=event{text.lock().unwrap().push_str(&part);}Ok(())}).await.unwrap();
        assert_eq!(*text.lock().unwrap(),"你好");
        let response=client.get(format!("http://{address}/v1/models")).send().await.unwrap();
        let error=check_response(response).await.unwrap_err();assert!(error.contains("401"));assert!(!error.contains("SECRET"));
        server.join().unwrap();
    }
    #[cfg(windows)]
    #[test]
    fn system_credential_round_trip_never_enters_public_profile() {
        let id=format!("netape-test-{}",uuid::Uuid::new_v4());
        let entry=credential(&id).unwrap();entry.set_password("netape-disposable-test-value").unwrap();
        let result=api_key(&id);entry.delete_credential().unwrap();
        assert_eq!(result.unwrap().as_deref(),Some("netape-disposable-test-value"));
        assert!(api_key(&id).unwrap().is_none());
        let serialized=serde_json::to_string(&Config::default()).unwrap();assert!(!serialized.contains("apiKey"));
    }
}
