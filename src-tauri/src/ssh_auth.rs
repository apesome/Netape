//! Shared SSH authentication helpers used by both the terminal and SFTP
//! connection paths:
//!
//! * [`resolve_pubkeys`] — turn a host's stored key id (or "auto") into the list
//!   of candidate private keys, decoded from the key manager.
//! * [`KbiState`] — bridges the protocol layer's keyboard-interactive callback
//!   to the frontend: it emits a prompt event and waits for the user's answer.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use base64::Engine;
use netape_domain::keymgr::KeyManager;
use netape_protocol::ssh::{KbiPrompt, KbiResponder, PrivateKeyEntry};
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;
use uuid::Uuid;

/// Decode a key manager record's Base64 private key into PEM text.
fn decode_pem(b64: &str) -> String {
    String::from_utf8_lossy(
        &base64::engine::general_purpose::STANDARD
            .decode(b64)
            .unwrap_or_default(),
    )
    .into_owned()
}

/// Resolve the candidate private keys for public-key auth.
///
/// * `Some(id)` (non-empty) → that single key from the key manager.
/// * `None` / empty → every key in the key manager ("auto-select": each is
///   tried in turn until one authenticates).
pub fn resolve_pubkeys(key_mgr: &KeyManager, key_id: Option<&str>) -> Vec<PrivateKeyEntry> {
    match key_id {
        Some(id) if !id.is_empty() => key_mgr
            .get(id)
            .ok()
            .flatten()
            .map(|kp| {
                vec![PrivateKeyEntry {
                    private_key_pem: decode_pem(&kp.private_key),
                    passphrase: None,
                }]
            })
            .unwrap_or_default(),
        _ => key_mgr
            .key_pairs()
            .unwrap_or_default()
            .iter()
            .map(|kp| PrivateKeyEntry {
                private_key_pem: decode_pem(&kp.private_key),
                passphrase: None,
            })
            .collect(),
    }
}

// ---------------------------------------------------------------------------
// Keyboard-interactive bridge
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone)]
struct KbiPromptDto {
    prompt: String,
    echo: bool,
}

#[derive(Serialize, Clone)]
struct KbiRequestDto {
    #[serde(rename = "reqId")]
    req_id: String,
    name: String,
    instructions: String,
    prompts: Vec<KbiPromptDto>,
}

/// Tauri-managed state holding in-flight keyboard-interactive requests, keyed by
/// a generated request id. The frontend answers via the `ssh_kbi_respond`
/// command, which fulfils the matching oneshot channel.
#[derive(Clone, Default)]
pub struct KbiState {
    pending: Arc<Mutex<HashMap<String, oneshot::Sender<Vec<String>>>>>,
}

impl KbiState {
    /// Build a responder for the protocol layer. When the server issues a
    /// challenge, this emits `ssh://kbi-request` to the frontend and waits for
    /// the user's answers.
    pub fn make_responder(&self, app: AppHandle) -> KbiResponder {
        let pending = Arc::clone(&self.pending);
        Arc::new(move |name: String, instructions: String, prompts: Vec<KbiPrompt>| {
            let pending = Arc::clone(&pending);
            let app = app.clone();
            Box::pin(async move {
                let req_id = Uuid::new_v4().to_string();
                let (tx, rx) = oneshot::channel::<Vec<String>>();
                pending.lock().unwrap().insert(req_id.clone(), tx);

                let dto = KbiRequestDto {
                    req_id: req_id.clone(),
                    name,
                    instructions,
                    prompts: prompts
                        .into_iter()
                        .map(|p| KbiPromptDto { prompt: p.prompt, echo: p.echo })
                        .collect(),
                };
                let _ = app.emit("ssh://kbi-request", dto);

                // Wait for the frontend; if the channel drops (dialog cancelled
                // or window closed), fall back to empty answers so the auth
                // attempt fails cleanly instead of hanging forever.
                match rx.await {
                    Ok(answers) => answers,
                    Err(_) => {
                        pending.lock().unwrap().remove(&req_id);
                        Vec::new()
                    }
                }
            })
        })
    }

    /// Fulfil a pending request with the user's answers.
    pub fn respond(&self, req_id: &str, answers: Vec<String>) {
        if let Some(tx) = self.pending.lock().unwrap().remove(req_id) {
            let _ = tx.send(answers);
        }
    }
}

/// Frontend → backend: deliver the user's answers for a keyboard-interactive
/// prompt request.
#[tauri::command]
pub fn ssh_kbi_respond(
    state: tauri::State<'_, KbiState>,
    req_id: String,
    answers: Vec<String>,
) -> Result<(), String> {
    state.respond(&req_id, answers);
    Ok(())
}
