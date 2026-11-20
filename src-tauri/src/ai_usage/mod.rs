//! Usage query providers
//!
//! Each provider is implemented in its own module for easy maintenance and extension.

use serde::{Deserialize, Serialize};

pub mod deepseek;
pub mod kimi;
pub mod minimax;
pub mod moonshot;
pub mod novita;
pub mod opencode;
pub mod openrouter;
pub mod siliconflow;
pub mod stepfun;
pub mod zhipu;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum QuotaPeriod {
    FiveHour,
    Daily,
    Weekly,
    Monthly,
}

/// Single usage quota data (progress bar)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageQuota {
    pub percentage: f64, // Used percentage, 0-100
    pub reset_at: i64,   // Unix timestamp (ms); 0 when the reset time is unknown
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub period: Option<QuotaPeriod>,
    // Balance display (for providers like DeepSeek that show remaining balance)
    pub balance: Option<f64>,         // Remaining balance (e.g., 10.50 USD)
    pub balance_unit: Option<String>, // Currency unit (e.g., "USD", "CNY", "Credits")
    // The amount is what was spent, for keys that have no balance to report.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub spent: bool,
}

impl UsageQuota {
    fn balance(amount: f64, unit: &str) -> Option<Self> {
        (amount.is_finite() && !unit.trim().is_empty()).then(|| Self {
            percentage: 0.0,
            reset_at: 0,
            period: None,
            balance: Some(amount),
            balance_unit: Some(unit.to_string()),
            spent: false,
        })
    }

    fn window(period: QuotaPeriod, used: f64, reset_at: Option<i64>) -> Option<Self> {
        used.is_finite().then(|| Self {
            percentage: used.clamp(0.0, 100.0),
            reset_at: reset_at.filter(|value| *value > 0).unwrap_or(0),
            period: Some(period),
            balance: None,
            balance_unit: None,
            spent: false,
        })
    }
}

/// Model usage data
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelUsageData {
    pub quotas: Vec<UsageQuota>,
    pub last_updated: Option<i64>, // Unix timestamp (ms)
}

/// Usage query result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsageResult {
    pub success: bool,
    pub data: Option<ModelUsageData>,
    pub error: Option<String>,
}

impl UsageResult {
    fn from_quotas(quotas: Vec<UsageQuota>) -> Self {
        if quotas.is_empty() {
            return Self::failure("No usage data available");
        }
        Self {
            success: true,
            data: Some(ModelUsageData {
                quotas,
                last_updated: Some(now_millis()),
            }),
            error: None,
        }
    }

    /// Nothing to show and nothing to report: the UI says "暂无用量数据" rather
    /// than raising an error, for sites that simply do not offer this query.
    fn no_data() -> Self {
        Self {
            success: false,
            data: None,
            error: None,
        }
    }

    fn failure(message: impl Into<String>) -> Self {
        Self {
            success: false,
            data: None,
            error: Some(message.into()),
        }
    }
}

fn parse_reset_time(value: &serde_json::Value) -> Option<i64> {
    if let Some(text) = value.as_str() {
        if let Ok(time) = chrono::DateTime::parse_from_rfc3339(text) {
            return (time.timestamp_millis() > 0).then_some(time.timestamp_millis());
        }
    }
    let value = value.as_i64().or_else(|| value.as_str()?.parse().ok())?;
    if value <= 0 {
        return None;
    }
    Some(if value < 1_000_000_000_000 {
        value * 1000
    } else {
        value
    })
}

fn api_url(base_url: &str, hosts: &[&str]) -> Option<reqwest::Url> {
    let url = reqwest::Url::parse(base_url).ok()?;
    (url.scheme() == "https"
        && hosts.contains(&url.host_str()?)
        && url.username().is_empty()
        && url.password().is_none() && url.query().is_none() && url.fragment().is_none())
    .then_some(url)
}

async fn fetch_usage(url: &str, authorization: &str) -> Result<serde_json::Value, String> {
    send_usage_request(
        reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).connect_timeout(std::time::Duration::from_secs(10)).build().map_err(|_|"Cannot create usage client")?
            .get(url)
            .header("Authorization", authorization),
    )
    .await
}

fn usage_status_error(status: reqwest::StatusCode) -> String {
    match status.as_u16() {
        401 => "Usage authentication failed (HTTP 401)".to_string(),
        403 => "Usage access denied; check the key and subscription (HTTP 403)".to_string(),
        _ => format!("Usage API error (HTTP {status})"),
    }
}

async fn send_usage_request(request: reqwest::RequestBuilder) -> Result<serde_json::Value, String> {
    let response=request.header("Accept","application/json").timeout(std::time::Duration::from_secs(15))
        .send().await.map_err(|_|"Unable to reach the usage API")?;
    if !response.status().is_success(){return Err(usage_status_error(response.status()));}
    use futures::StreamExt;
    let mut stream=response.bytes_stream();let mut bytes=Vec::new();
    while let Some(chunk)=stream.next().await {let chunk=chunk.map_err(|_|"Interrupted usage response")?;
        if bytes.len()+chunk.len()>1_000_000{return Err("Usage response exceeded limit".into());}bytes.extend_from_slice(&chunk);}
    serde_json::from_slice(&bytes).map_err(|_|"Invalid usage API response".into())
}
#[allow(dead_code)]
trait UsageProvider {
    async fn query_usage(&self, api_key:&str, base_url:&str)->Result<UsageResult,String>;
    fn can_handle(&self,base_url:&str)->bool;
    fn name(&self)->&'static str;
}
#[tauri::command]
pub async fn ai_usage_get(profile_id:String,state:tauri::State<'_,crate::app_state::AppState>)->Result<UsageResult,String>{
    let profile=crate::ai::load_config(&state)?.profiles.into_iter().find(|p|p.id==profile_id).ok_or("AI profile not found")?;
    crate::ai_catalog::normalized_base(&profile.base_url)?;
    query_usage(&profile.base_url, &crate::ai::api_key(&profile_id)?.unwrap_or_default()).await
}
async fn query_usage(base:&str,key:&str)->Result<UsageResult,String>{
    if deepseek::DeepSeekProvider.can_handle(base) { if key.trim().is_empty(){return Ok(UsageResult::failure("API key is empty"));}return deepseek::DeepSeekProvider.query_usage(key,base).await; }
    if kimi::KimiProvider.can_handle(base) { if key.trim().is_empty(){return Ok(UsageResult::failure("API key is empty"));}return kimi::KimiProvider.query_usage(key,base).await; }
    if moonshot::MoonshotProvider.can_handle(base) { if key.trim().is_empty(){return Ok(UsageResult::failure("API key is empty"));}return moonshot::MoonshotProvider.query_usage(key,base).await; }
    if minimax::MiniMaxProvider.can_handle(base) { if key.trim().is_empty(){return Ok(UsageResult::failure("API key is empty"));}return minimax::MiniMaxProvider.query_usage(key,base).await; }
    if novita::NovitaProvider.can_handle(base) { if key.trim().is_empty(){return Ok(UsageResult::failure("API key is empty"));}return novita::NovitaProvider.query_usage(key,base).await; }
    if opencode::OpenCodeProvider.can_handle(base) { if key.trim().is_empty(){return Ok(UsageResult::failure("API key is empty"));}return opencode::OpenCodeProvider.query_usage(key,base).await; }
    if openrouter::OpenRouterProvider.can_handle(base) { if key.trim().is_empty(){return Ok(UsageResult::failure("API key is empty"));}return openrouter::OpenRouterProvider.query_usage(key,base).await; }
    if siliconflow::SiliconFlowProvider.can_handle(base) { if key.trim().is_empty(){return Ok(UsageResult::failure("API key is empty"));}return siliconflow::SiliconFlowProvider.query_usage(key,base).await; }
    if stepfun::StepFunProvider.can_handle(base) { if key.trim().is_empty(){return Ok(UsageResult::failure("API key is empty"));}return stepfun::StepFunProvider.query_usage(key,base).await; }
    if zhipu::ZhipuProvider.can_handle(base) { if key.trim().is_empty(){return Ok(UsageResult::failure("API key is empty"));}return zhipu::ZhipuProvider.query_usage(key,base).await; }
    Ok(UsageResult::failure("AI_USAGE_UNSUPPORTED"))
}
/// Helper function to get current timestamp in milliseconds
pub(crate) fn now_millis() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

/// Helper function to parse f64 from JSON value (supports both number and string)
pub(crate) fn parse_f64(value: &serde_json::Value) -> Option<f64> {
    value
        .as_f64()
        .or_else(|| value.as_str().and_then(|s| s.parse().ok()))
        .filter(|value| value.is_finite())
}


#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn usage_hosts_reject_lookalikes_credentials_queries_and_http() {
        for base in ["http://api.deepseek.com/v1","https://api.deepseek.com.evil.test/v1","https://evil.test/api.deepseek.com","https://user@api.deepseek.com/v1","https://api.deepseek.com/v1?key=x"] {
            assert!(api_url(base,&["api.deepseek.com"]).is_none());
        }
        assert!(api_url("https://api.deepseek.com/v1",&["api.deepseek.com"]).is_some());
    }
    #[tokio::test] async fn unsupported_hosts_do_not_make_any_network_request() {
        assert_eq!(query_usage("https://custom.test/v1","secret").await.unwrap().error.as_deref(),Some("AI_USAGE_UNSUPPORTED"));
        assert_eq!(query_usage("https://api.deepseek.com/v1","").await.unwrap().error.as_deref(),Some("API key is empty"));
    }
    #[tokio::test] async fn usage_http_errors_are_sanitized_and_redirects_stay_blocked() {
        use std::io::{Read,Write};
        let listener=std::net::TcpListener::bind("127.0.0.1:0").unwrap();let address=listener.local_addr().unwrap();
        let server=std::thread::spawn(move||{for status in ["401 Unauthorized","302 Found"] {
            let (mut socket,_)=listener.accept().unwrap();let mut buf=[0;4096];socket.read(&mut buf).unwrap();
            let body="SECRET_DO_NOT_ECHO";
            write!(socket,"HTTP/1.1 {status}\r\nContent-Length: {}\r\nLocation: http://127.0.0.1:1/leak\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
        }});
        for code in ["401","302"] {let error=fetch_usage(&format!("http://{address}/usage"),"Bearer transient").await.unwrap_err();assert!(error.contains(code));assert!(!error.contains("SECRET"));}
        server.join().unwrap();
    }
}
