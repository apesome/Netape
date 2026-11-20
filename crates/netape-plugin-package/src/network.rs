use crate::{
    check_cancel, now, validate_url, verify_artifact, verify_catalog, Artifact, Catalog, Result,
    SignatureEnvelope, TrustConfig,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use futures::StreamExt;
use reqwest::{Client, StatusCode};
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::{path::Path, sync::atomic::AtomicBool, time::Duration};

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Cache {
    payload: String,
    signature: SignatureEnvelope,
    etag: Option<String>,
}

pub struct CatalogLoad {
    pub catalog: Catalog,
    pub from_cache: bool,
    pub warning: Option<String>,
}

fn client(trust: &TrustConfig, timeout: u64) -> Result<Client> {
    let trust = trust.clone();
    Client::builder()
        .https_only(true)
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(timeout))
        .user_agent("Netape-plugin-marketplace/1")
        .redirect(reqwest::redirect::Policy::custom(move |attempt| {
            if attempt.previous().len() >= 4
                || validate_url(attempt.url().as_str(), &trust).is_err()
            {
                attempt.stop()
            } else {
                attempt.follow()
            }
        }))
        .build()
        .map_err(|e| e.to_string())
}

pub(crate) async fn bounded_response(response: reqwest::Response, limit: usize) -> Result<Vec<u8>> {
    let response = response.error_for_status().map_err(|e| e.to_string())?;
    if response
        .content_length()
        .is_some_and(|size| size > limit as u64)
    {
        return Err("Plugin response exceeds size limit".into());
    }
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        if bytes.len().saturating_add(chunk.len()) > limit {
            return Err("Plugin response exceeds size limit".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

pub async fn load_catalog(trust: &TrustConfig, cache_path: &Path) -> Result<CatalogLoad> {
    validate_url(&trust.index_url, trust)?;
    let timestamp = now();
    let cached = std::fs::metadata(cache_path)
        .ok()
        .filter(|meta| meta.len() <= 2 * 1024 * 1024)
        .and_then(|_| std::fs::read(cache_path).ok())
        .and_then(|bytes| serde_json::from_slice::<Cache>(&bytes).ok())
        .and_then(|cache| {
            STANDARD.decode(&cache.payload).ok().and_then(|bytes| {
                verify_catalog(&bytes, &cache.signature, trust, timestamp)
                    .ok()
                    .map(|catalog| (cache, catalog))
            })
        });
    let fetch: Result<CatalogLoad> = async {
        let client = client(trust, 15)?;
        let mut request = client.get(&trust.index_url);
        if let Some((cache, _)) = &cached {
            if let Some(etag) = &cache.etag {
                request = request.header(reqwest::header::IF_NONE_MATCH, etag);
            }
        }
        let response = request
            .send()
            .await
            .map_err(|e| format!("Cannot fetch plugin catalog: {e}"))?;
        if response.status() == StatusCode::NOT_MODIFIED {
            return cached
                .as_ref()
                .map(|(_, catalog)| CatalogLoad {
                    catalog: catalog.clone(),
                    from_cache: true,
                    warning: None,
                })
                .ok_or("Catalog returned 304 without a valid cache".into());
        }
        let etag = response
            .headers()
            .get(reqwest::header::ETAG)
            .and_then(|header| header.to_str().ok())
            .map(str::to_owned);
        let bytes = bounded_response(response, 1024 * 1024).await?;
        let signature_url = format!("{}.sig", trust.index_url);
        validate_url(&signature_url, trust)?;
        let signature_bytes = bounded_response(
            client
                .get(signature_url)
                .send()
                .await
                .map_err(|e| e.to_string())?,
            4096,
        )
        .await?;
        let signature: SignatureEnvelope =
            serde_json::from_slice(&signature_bytes).map_err(|_| "Invalid signature envelope")?;
        let catalog = verify_catalog(&bytes, &signature, trust, timestamp)?;
        if cached
            .as_ref()
            .is_some_and(|(_, previous)| previous.generated_at > catalog.generated_at)
        {
            return Err("Older plugin catalog rejected".into());
        }
        let cache = Cache {
            payload: STANDARD.encode(&bytes),
            signature,
            etag,
        };
        // Cache is optional; offline use always verifies its signature and expiry again.
        if let Some(parent) = cache_path.parent() {
            if std::fs::create_dir_all(parent).is_ok() {
                if let Ok(mut temp) = tempfile::NamedTempFile::new_in(parent) {
                    if serde_json::to_writer(&mut temp, &cache).is_ok()
                        && temp.as_file().sync_all().is_ok()
                    {
                        let _ = temp.persist(cache_path);
                    }
                }
            }
        }
        Ok(CatalogLoad {
            catalog,
            from_cache: false,
            warning: None,
        })
    }
    .await;
    match fetch {
        Ok(value) => Ok(value),
        Err(error) => cached
            .map(|(_, catalog)| CatalogLoad {
                catalog,
                from_cache: true,
                warning: Some(error.clone()),
            })
            .ok_or(error),
    }
}

pub async fn download_artifact(
    artifact: &Artifact,
    trust: &TrustConfig,
    path: &Path,
    cancel: &AtomicBool,
    progress: impl Fn(u64, u64),
) -> Result<()> {
    check_cancel(cancel)?;
    validate_url(&artifact.url, trust)?;
    if artifact.size == 0 || artifact.size > crate::MAX_ARCHIVE {
        return Err("Plugin archive exceeds size limit".into());
    }
    let client = client(trust, 180)?;
    let cancelled = async {
        loop {
            tokio::time::sleep(Duration::from_millis(100)).await;
            if check_cancel(cancel).is_err() {
                break;
            }
        }
    };
    tokio::pin!(cancelled);
    let response = tokio::select! {
        _ = &mut cancelled => return Err("Plugin installation cancelled".into()),
        response = client.get(&artifact.url).send() => response.map_err(|e| e.to_string())?.error_for_status().map_err(|e| e.to_string())?,
    };
    if response
        .content_length()
        .is_some_and(|size| size != artifact.size)
    {
        return Err("Plugin archive size mismatch".into());
    }
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|e| e.to_string())?;
    let mut stream = response.bytes_stream();
    let mut received: u64 = 0;
    let mut last_percent = 101;
    loop {
        let chunk = tokio::select! {
            _ = &mut cancelled => return Err("Plugin installation cancelled".into()),
            chunk = stream.next() => chunk,
        };
        let Some(chunk) = chunk else { break };
        let chunk = chunk.map_err(|e| e.to_string())?;
        received = received
            .checked_add(chunk.len() as u64)
            .filter(|size| *size <= artifact.size)
            .ok_or("Plugin archive exceeds declared size")?;
        file.write_all(&chunk).map_err(|e| e.to_string())?;
        let percent = received * 100 / artifact.size;
        if percent != last_percent {
            progress(received, artifact.size);
            last_percent = percent;
        }
    }
    file.sync_all().map_err(|e| e.to_string())?;
    drop(file);
    check_cancel(cancel)?;
    verify_artifact(path, artifact)
}
