use rand::SeedableRng;
use rand::rngs::StdRng;
use russh::keys::ssh_key::{Algorithm, LineEnding};
use russh::keys::PrivateKey;

use crate::error::{ProtocolError, ProtocolResult};

pub fn generate_ed25519() -> ProtocolResult<(String, String)> {
    // StdRng: TryCryptoRng<Error=Infallible> → satisfies CryptoRng blanket impl.
    let mut rng = StdRng::try_from_rng(&mut rand::rngs::SysRng)
        .map_err(|e| ProtocolError::Other(format!("RNG init: {e}")))?;
    let key = PrivateKey::random(&mut rng, Algorithm::Ed25519)
        .map_err(|e| ProtocolError::Other(format!("ED25519 keygen: {e}")))?;
    export_key(key)
}

pub fn generate_rsa() -> ProtocolResult<(String, String)> {
    let mut rng = StdRng::try_from_rng(&mut rand::rngs::SysRng)
        .map_err(|e| ProtocolError::Other(format!("RNG init: {e}")))?;
    let key = PrivateKey::random(&mut rng, Algorithm::Rsa { hash: None })
        .map_err(|e| ProtocolError::Other(format!("RSA keygen: {e}")))?;
    export_key(key)
}

/// Parse a private key PEM and return `(public_openssh, private_pem, key_type, bits)`.
pub fn import_private_key(pem: &str) -> ProtocolResult<(String, String, String, u32)> {
    let key = PrivateKey::from_openssh(pem)
        .map_err(|e| ProtocolError::Other(format!("parse private key: {e}")))?;
    let (pub_key, priv_pem) = export_key(key.clone())?;
    let (key_type, bits) = match key.algorithm() {
        russh::keys::ssh_key::Algorithm::Rsa { .. } => ("RSA".to_string(), 2048u32),
        _ => ("ED25519".to_string(), 0u32),
    };
    Ok((pub_key, priv_pem, key_type, bits))
}

fn export_key(key: PrivateKey) -> ProtocolResult<(String, String)> {
    let private_pem = key
        .to_openssh(LineEnding::LF)
        .map_err(|e| ProtocolError::Other(format!("private key export: {e}")))?
        .to_string();

    let public_openssh = key
        .public_key()
        .to_openssh()
        .map_err(|e| ProtocolError::Other(format!("public key export: {e}")))?;

    Ok((public_openssh, private_pem))
}
