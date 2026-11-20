//! Draft model configuration, bounded discovery and credential-scoped cache.
use std::{collections::{HashMap, HashSet}, sync::Mutex, time::{Duration, Instant, SystemTime, UNIX_EPOCH}};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use futures::StreamExt;
use tauri::State;
use crate::{ai::{self, Profile, ChatMessage}, app_state::AppState};

#[derive(Deserialize)]
#[serde(rename_all="camelCase")]
pub struct Draft {
    pub profile_id:String, pub base_url:String, #[serde(default)] pub model:String,
    /// None means unchanged; empty means explicitly keyless. Never persisted by discovery/test.
    pub api_key:Option<String>,
    #[serde(default = "ai::default_protocol")] pub protocol:String,
}
#[derive(Clone, Serialize)]
#[serde(rename_all="camelCase")]
pub struct Catalog { pub models:Vec<String>, pub fetched_at:u64, pub cached:bool }
struct Cached { value:Catalog, at:Instant }
#[derive(Default)]
pub struct CatalogState { entries:Mutex<HashMap<[u8;32],Cached>> }
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct Probe { pub success:bool, pub mode:String, pub latency_ms:u64, pub checked_at:u64, pub error:Option<String> }
fn now()->u64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64 }
pub fn normalized_base(raw:&str)->Result<String,String> {
    if raw.len()>4096{return Err("AI_INVALID_URL".into());}
    let mut url=reqwest::Url::parse(raw.trim()).map_err(|_|"AI_INVALID_URL")?;
    if !matches!(url.scheme(),"https"|"http") || url.host_str().is_none() || !url.username().is_empty()
        || url.password().is_some() || url.query().is_some() || url.fragment().is_some() {return Err("AI_INVALID_URL".into());}
    let mut path=url.path().trim_end_matches('/').to_string();
    for suffix in ["/chat/completions","/models","/messages"] {if path.ends_with(suffix){path.truncate(path.len()-suffix.len());break;}}
    if path.is_empty() && url.host_str()!=Some("api.perplexity.ai"){path="/v1".into();}
    url.set_path(&path); Ok(url.to_string().trim_end_matches('/').to_owned())
}
fn resolve(draft:&Draft,state:&AppState)->Result<(Profile,String),String> {
    let base=normalized_base(&draft.base_url)?;
    if !["", "openai", "anthropic"].contains(&draft.protocol.as_str()) {return Err("AI_INVALID_PROTOCOL".into());}
    if draft.model.len()>200 {return Err("AI_INVALID_MODEL".into());}
    let key=if let Some(key)=&draft.api_key {key.trim().to_owned()} else {
        let saved=ai::load_config(state)?.profiles.into_iter().find(|profile| profile.id==draft.profile_id);
        match saved {
            Some(saved) if normalized_base(&saved.base_url)?==base && saved.protocol==draft.protocol=>ai::api_key(&saved.id)?.unwrap_or_default(),
            _=>String::new(),
        }
    };
    if key.len()>8192 || reqwest::header::HeaderValue::from_str(&key).is_err() {return Err("AI_INVALID_KEY".into());}
    Ok((Profile{id:draft.profile_id.clone(),name:String::new(),base_url:base,model:draft.model.trim().to_owned(),has_key:!key.is_empty(),protocol:draft.protocol.clone(),provider_id:None,edition_id:None},key))
}
fn fingerprint(base:&str,key:&str,protocol:&str)->[u8;32] {
    let mut hash=Sha256::new();
    for part in [base,key,protocol] {hash.update((part.len() as u64).to_le_bytes());hash.update(part.as_bytes());}
    hash.finalize().into()
}
impl CatalogState {
    fn get(&self,base:&str,key:&str,protocol:&str)->Option<Catalog> {
        self.entries.lock().unwrap().get(&fingerprint(base,key,protocol)).filter(|cached|cached.at.elapsed()<Duration::from_secs(600))
            .map(|cached|Catalog{cached:true,..cached.value.clone()})
    }
    fn insert(&self,base:&str,key:&str,protocol:&str,value:Catalog) {
        let mut entries=self.entries.lock().unwrap();
        entries.retain(|_,cached|cached.at.elapsed()<Duration::from_secs(600));
        if entries.len()>=64 {entries.clear();}
        entries.insert(fingerprint(base,key,protocol),Cached{value,at:Instant::now()});
    }
}
fn client(timeout:u64)->Result<reqwest::Client,String> {
    reqwest::Client::builder().timeout(Duration::from_secs(timeout.clamp(10,120))).connect_timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none()).build().map_err(|_|"AI_CONNECTION_FAILED".into())
}
fn status_error(status:reqwest::StatusCode)->String {
    match status.as_u16(){401|403=>"AI_KEY_REJECTED".into(),404|405=>"AI_ENDPOINT_UNSUPPORTED".into(),429=>"AI_RATE_LIMITED".into(),code=>format!("AI_HTTP_{code}")}
}
async fn json_body(response:reqwest::Response)->Result<Value,String> {
    if !response.status().is_success(){return Err(status_error(response.status()));}
    let mut stream=response.bytes_stream();let mut bytes=Vec::new();
    while let Some(chunk)=stream.next().await {
        let chunk=chunk.map_err(|_|"AI_RESPONSE_INTERRUPTED")?;
        if bytes.len()+chunk.len()>2_000_000{return Err("AI_RESPONSE_TOO_LARGE".into());}bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_|"AI_INVALID_RESPONSE".into())
}
fn catalog_request(client:&reqwest::Client,profile:&Profile,key:&str)->Result<(reqwest::RequestBuilder,bool),String> {
    let base=normalized_base(&profile.base_url)?;
    if profile.protocol!="anthropic" && base.ends_with("/v1beta/openai") {
        let request=client.get(format!("{}/models",base.trim_end_matches("/openai")));
        return Ok((if key.is_empty(){request}else{request.header("x-goog-api-key",key)},true));
    }
    Ok((ai::authorize(client.get(ai::api_url(profile,"models")?),key,&profile.protocol),false))
}
pub(crate) async fn discover(profile:&Profile,key:&str,timeout:u64)->Result<Catalog,String> {
    let client=client(timeout)?;let mut models=Vec::new();let mut seen=HashSet::new();let mut cursor:Option<String>=None;
    for page in 0..10 {
        let (mut request,google)=catalog_request(&client,profile,key)?;
        if let Some(cursor)=&cursor {request=request.query(&[(if google {"pageToken"} else if profile.protocol=="anthropic" {"after_id"} else {"after"},cursor)]);}
        let response=request.send().await.map_err(|_|"AI_CONNECTION_FAILED")?;
        let value=json_body(response).await?;
        let entries=value[if google {"models"} else {"data"}].as_array().ok_or("AI_MODELS_UNSUPPORTED")?;
        for model in entries {
            if google && !model["supportedGenerationMethods"].as_array().is_some_and(|methods|methods.iter().any(|method|method=="generateContent")) {continue;}
            if let Some(id)=model[if google {"name"} else {"id"}].as_str().map(|id|if google{id.strip_prefix("models/").unwrap_or(id)}else{id}).filter(|id|!id.is_empty()&&id.len()<=200) {
                if seen.insert(id.to_owned()){models.push(id.to_owned());}
            }
        }
        if models.len()>10000{return Err("AI_RESPONSE_TOO_LARGE".into());}
        if (google && value["nextPageToken"].as_str().is_none_or(str::is_empty)) || (!google && value["has_more"]!=true) {return Ok(Catalog{models,fetched_at:now(),cached:false});}
        let next=value[if google {"nextPageToken"} else {"last_id"}].as_str().or_else(||entries.last().and_then(|model|model["id"].as_str())).ok_or("AI_INVALID_RESPONSE")?.to_owned();
        if cursor.as_ref()==Some(&next)||page==9{return Err("AI_CATALOG_PAGE_LIMIT".into());}cursor=Some(next);
    }
    unreachable!()
}
#[tauri::command]
pub fn ai_catalog_cached(draft:Draft,state:State<'_,AppState>,catalog:State<'_,CatalogState>)->Result<Option<Catalog>,String> {
    let (profile,key)=resolve(&draft,&state)?;Ok(catalog.get(&profile.base_url,&key,&profile.protocol))
}
#[tauri::command]
pub async fn ai_catalog_refresh(draft:Draft,state:State<'_,AppState>,catalog:State<'_,CatalogState>)->Result<Catalog,String> {
    let (profile,key)=resolve(&draft,&state)?;
    let value=discover(&profile,&key,ai::load_config(&state)?.timeout_secs).await?;
    catalog.insert(&profile.base_url,&key,&profile.protocol,value.clone());Ok(value)
}
async fn probe(profile:&Profile,key:&str,mode:&str,timeout:u64)->Result<(),String> {
    let client=client(timeout)?;
    if mode=="connection" {
        let response=catalog_request(&client,profile,key)?.0.send().await.map_err(|_|"AI_CONNECTION_FAILED")?;
        if response.status().is_success(){Ok(())}else{Err(status_error(response.status()))}
    }else if mode=="model" {
        if profile.model.is_empty(){return Err("AI_MODEL_REQUIRED".into());}
        let body=ai::chat_body(profile,&[ChatMessage{role:"user".into(),content:"Reply with OK".into()}],128,false);
        let value=json_body(ai::authorize(client.post(ai::api_url(profile,"chat/completions")?),key,&profile.protocol).json(&body).send().await.map_err(|_|"AI_CONNECTION_FAILED")?).await?;
        if ai::response_text(&value,&profile.protocol).is_some_and(|text|!text.is_empty()){Ok(())}else{Err("AI_MODEL_NO_TEXT".into())}
    }else{Err("AI_INVALID_TEST_MODE".into())}
}
#[tauri::command]
pub async fn ai_probe(draft:Draft,mode:String,state:State<'_,AppState>)->Result<Probe,String> {
    let (profile,key)=resolve(&draft,&state)?;let start=Instant::now();
    let result=probe(&profile,&key,&mode,ai::load_config(&state)?.timeout_secs).await;
    Ok(Probe{success:result.is_ok(),mode,latency_ms:start.elapsed().as_millis() as u64,checked_at:now(),error:result.err()})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn normalizes_api_roots_and_complete_endpoints() {
        for (input,expected) in [("https://example.com/","https://example.com/v1"),("https://example.com/v1/chat/completions/","https://example.com/v1"),
            ("http://localhost:11434/v1/models","http://localhost:11434/v1"),("https://example.com/api/paas/v4","https://example.com/api/paas/v4")] {
            assert_eq!(normalized_base(input).unwrap(),expected);
        }
        for input in ["file:///tmp/a","https://secret@example.com","https://example.com?key=secret"]{assert!(normalized_base(input).is_err());}
    }
    #[test] fn cache_is_scoped_by_endpoint_and_credentials() {
        let cache=CatalogState::default();cache.insert("https://a/v1","key-one","openai",Catalog{models:vec!["m".into()],fetched_at:1,cached:false});
        assert!(cache.get("https://a/v1","key-one","openai").unwrap().cached);
        assert!(cache.get("https://a/v1","key-one","anthropic").is_none());
        assert!(cache.get("https://a/v1","key-two","openai").is_none());assert!(cache.get("https://b/v1","key-one","openai").is_none());
    }
    #[test] fn changed_endpoint_never_receives_saved_key() {
        let store=netape_store::db::Store::open_in_memory().unwrap();
        let state=AppState{store,owner:netape_store::model::local_owner()};
        let draft=Draft{profile_id:"default".into(),base_url:"https://other.test/v1".into(),model:String::new(),api_key:None,protocol:String::new()};
        assert!(resolve(&draft,&state).unwrap().1.is_empty());
        assert!(resolve(&Draft{api_key:Some("".into()),base_url:"https://api.openai.com/v1".into(),..draft},&state).unwrap().1.is_empty());
    }
    #[tokio::test] async fn discovers_paginated_models_and_tests_the_actual_model() {
        use std::io::{Read,Write};
        let listener=std::net::TcpListener::bind("127.0.0.1:0").unwrap();let address=listener.local_addr().unwrap();
        let server=std::thread::spawn(move||{
            for (index,(status,body)) in [
                ("200 OK",r#"{"data":[{"id":"one"},{"id":"two"}],"has_more":true,"last_id":"two"}"#),
                ("200 OK",r#"{"data":[{"id":"two"},{"id":"three"}],"has_more":false}"#),
                ("200 OK",r#"{"data":[]}"#),
                ("200 OK",r#"{"choices":[{"message":{"content":"OK"}}]}"#),
                ("401 Unauthorized",r#"{"error":"SECRET_MUST_NOT_LEAK"}"#),
            ].into_iter().enumerate(){
                let (mut socket,_)=listener.accept().unwrap();socket.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
                let mut received=Vec::new();
                loop {
                    let mut bytes=[0;4096];let count=socket.read(&mut bytes).unwrap();if count==0{break;}received.extend_from_slice(&bytes[..count]);
                    if let Some(end)=received.windows(4).position(|w|w==b"\r\n\r\n") {
                        let headers=String::from_utf8_lossy(&received[..end]).to_lowercase();
                        let length=headers.lines().find_map(|line|line.strip_prefix("content-length:").and_then(|v|v.trim().parse::<usize>().ok())).unwrap_or(0);
                        if received.len()>=end+4+length{break;}
                    }
                }
                let request=String::from_utf8_lossy(&received);
                assert!(request.to_lowercase().contains("authorization: bearer transient-key"));
                if index==1{assert!(request.contains("after=two"));}
                if index==3{assert!(request.starts_with("POST /v1/chat/completions"));}
                write!(socket,"HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
            }
        });
        let profile=Profile{id:"draft".into(),name:String::new(),base_url:format!("http://{address}/v1"),model:"demo".into(),has_key:false,protocol:"openai".into(),provider_id:None,edition_id:None};
        let catalog=discover(&profile,"transient-key",10).await.unwrap();assert_eq!(catalog.models,vec!["one","two","three"]);
        assert!(probe(&profile,"transient-key","connection",10).await.is_ok());
        assert!(probe(&profile,"transient-key","model",10).await.is_ok());
        let error=discover(&profile,"transient-key",10).await.err().unwrap();assert_eq!(error,"AI_KEY_REJECTED");assert!(!error.contains("SECRET"));
        server.join().unwrap();
    }
    #[tokio::test] async fn native_anthropic_catalog_and_model_probe_use_native_transport() {
        use std::io::{Read,Write};
        let listener=std::net::TcpListener::bind("127.0.0.1:0").unwrap();let address=listener.local_addr().unwrap();
        let server=std::thread::spawn(move||{
            for (index,(status,body)) in [
                ("200 OK",r#"{"data":[{"id":"one"},{"id":"two"}],"has_more":true,"last_id":"two"}"#),
                ("200 OK",r#"{"data":[{"id":"two"},{"id":"three"}],"has_more":false}"#),
                ("200 OK",r#"{"data":[]}"#),
                ("200 OK",r#"{"content":[{"type":"text","text":"OK"}]}"#),
                ("401 Unauthorized",r#"{"error":"SECRET_MUST_NOT_LEAK"}"#),
            ].into_iter().enumerate(){
                let (mut socket,_)=listener.accept().unwrap();socket.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
                let mut received=Vec::new();
                loop {
                    let mut bytes=[0;4096];let count=socket.read(&mut bytes).unwrap();if count==0{break;}received.extend_from_slice(&bytes[..count]);
                    if let Some(end)=received.windows(4).position(|w|w==b"\r\n\r\n") {
                        let headers=String::from_utf8_lossy(&received[..end]).to_lowercase();
                        let length=headers.lines().find_map(|line|line.strip_prefix("content-length:").and_then(|v|v.trim().parse::<usize>().ok())).unwrap_or(0);
                        if received.len()>=end+4+length{break;}
                    }
                }
                let request=String::from_utf8_lossy(&received);
                assert!(request.to_lowercase().contains("x-api-key: transient-key"));
                assert!(request.to_lowercase().contains("anthropic-version: 2023-06-01"));
                assert!(!request.to_lowercase().contains("authorization:"));
                if index==1{assert!(request.contains("after_id=two"));}
                if index==3{assert!(request.starts_with("POST /anthropic/v1/messages"));}
                write!(socket,"HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
            }
        });
        let profile=Profile{id:"draft".into(),name:String::new(),base_url:format!("http://{address}/anthropic/v1"),model:"demo".into(),has_key:false,protocol:"anthropic".into(),provider_id:None,edition_id:None};
        let catalog=discover(&profile,"transient-key",10).await.unwrap();assert_eq!(catalog.models,vec!["one","two","three"]);
        assert!(probe(&profile,"transient-key","connection",10).await.is_ok());
        assert!(probe(&profile,"transient-key","model",10).await.is_ok());
        let error=discover(&profile,"transient-key",10).await.err().unwrap();assert_eq!(error,"AI_KEY_REJECTED");assert!(!error.contains("SECRET"));
        server.join().unwrap();
    }
    #[tokio::test] async fn google_catalog_uses_native_auth_pagination_and_chat_ids() {
        use std::io::{Read,Write};
        let listener=std::net::TcpListener::bind("127.0.0.1:0").unwrap();let address=listener.local_addr().unwrap();
        let server=std::thread::spawn(move||{
            for (index,(status,body)) in [
                ("200 OK",r#"{"models":[{"name":"models/one","supportedGenerationMethods":["generateContent"]},{"name":"models/two","supportedGenerationMethods":["generateContent"]},{"name":"models/embed","supportedGenerationMethods":["embedContent"]}],"nextPageToken":"two"}"#),
                ("200 OK",r#"{"models":[{"name":"models/two","supportedGenerationMethods":["generateContent"]},{"name":"models/three","supportedGenerationMethods":["generateContent"]}]}"#),
                ("200 OK",r#"{"data":[]}"#),
                ("200 OK",r#"{"choices":[{"message":{"content":"OK"}}]}"#),
                ("401 Unauthorized",r#"{"error":"SECRET_MUST_NOT_LEAK"}"#),
            ].into_iter().enumerate(){
                let (mut socket,_)=listener.accept().unwrap();socket.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
                let mut received=Vec::new();
                loop {
                    let mut bytes=[0;4096];let count=socket.read(&mut bytes).unwrap();if count==0{break;}received.extend_from_slice(&bytes[..count]);
                    if let Some(end)=received.windows(4).position(|w|w==b"\r\n\r\n") {
                        let headers=String::from_utf8_lossy(&received[..end]).to_lowercase();
                        let length=headers.lines().find_map(|line|line.strip_prefix("content-length:").and_then(|v|v.trim().parse::<usize>().ok())).unwrap_or(0);
                        if received.len()>=end+4+length{break;}
                    }
                }
                let request=String::from_utf8_lossy(&received);
                if index==3 {assert!(request.to_lowercase().contains("authorization: bearer transient-key"));} else {assert!(request.starts_with("GET /v1beta/models"));assert!(request.to_lowercase().contains("x-goog-api-key: transient-key"));assert!(!request.to_lowercase().contains("authorization:"));}
                if index==1{assert!(request.contains("pageToken=two"));}
                if index==3{assert!(request.starts_with("POST /v1beta/openai/chat/completions"));}
                write!(socket,"HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
            }
        });
        let profile=Profile{id:"draft".into(),name:String::new(),base_url:format!("http://{address}/v1beta/openai"),model:"demo".into(),has_key:false,protocol:"openai".into(),provider_id:None,edition_id:None};
        let catalog=discover(&profile,"transient-key",10).await.unwrap();assert_eq!(catalog.models,vec!["one","two","three"]);
        assert!(probe(&profile,"transient-key","connection",10).await.is_ok());
        assert!(probe(&profile,"transient-key","model",10).await.is_ok());
        let error=discover(&profile,"transient-key",10).await.err().unwrap();assert_eq!(error,"AI_KEY_REJECTED");assert!(!error.contains("SECRET"));
        server.join().unwrap();
    }

}
