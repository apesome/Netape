# Online Plugins Implementation Plan

**Goal:** Keep current plugin features while adding a signed HTTPS catalog and verified in-app installation; declare the requested `AGPL-3.0` license consistently.

**Architecture:** A standalone Rust package owns catalog verification, bounded networking, archive validation and transactional installation. Tauri integrates it with the existing process host and session protection. GitHub Releases stores immutable packages; a static signed index selects artifacts by Rust target. Local directory installation remains supported. No public release or repository migration is performed here.

**Tech Stack:** Rust, reqwest/rustls, Ed25519, SHA-256, zip/tar.gz, React, Node.js publishing scripts.

## Tasks

1. Update Cargo/package/lock metadata and four README files to `AGPL-3.0`; add the full AGPL v3 text to root `LICENSE`. Preserve third-party notices.
2. Add `crates/netape-plugin-package`: strict manifest/catalog/target/version validation, pinned public keys, signed-index verification, bounded HTTPS/redirects, verified offline cache, archive size/digest checks, safe extraction, staged directory installation and rollback. Add tests for tampering, traversal, links, manifest mismatch and preservation of an existing installation.
3. Update `src-tauri/src/plugin.rs`, build target metadata and command registration. Merge remote/local/installed records with visible source and errors. Protect installation/uninstall with a mutation gate and active process leases; emit progress and support cancellation. Never execute downloaded code during installation.
4. Extract plugin settings into a focused React component with refresh/loading/cache/error states, per-plugin install/update progress and cancel. Keep installed/local management. Translate new strings in all four interface languages.
5. Track FTP/SMB manifests beside their crates and use independent versions. Add Node publishing commands to generate a local private signing key, build archives, compute sizes/digests, merge index entries, and sign exact index bytes. Commit only public trust configuration, never the private key or generated release artifacts.
6. Update plugin publishing documentation and README claims, including same-repository independent releases now and an optional later split using the stable stdio protocol.
7. Run package Rust tests, existing frontend tests, frontend build, then Tauri compile checks sequentially after frontend build. Exercise the UI with simulated IPC where useful. Record unavailable live publishing separately from tested client behavior.

No sub-agent work, commits, public uploads or changes to the user's removed release workflow are part of this implementation.

## Verification results

- `AGPL-3.0` is used in root Cargo/package/lock metadata and all four README files; the complete version 3 license is in `LICENSE`. About uses the installed application's license, not a potentially stale GitHub value.
- All 11 `netape-plugin-package` Rust tests passed with the installed Windows GNU toolchain. Cases include signature tampering/expiry, unsafe paths/links, archive corruption/expansion limits, offline signed cache, local copying, update failures and restoration after a failed final rename.
- All 43 Node tests passed, including publisher ZIP/tar.gz output, signature verification and progress calculations. The frontend production build and GNU Tauri `cargo check -p Netape` passed. MSVC was unavailable because `link.exe` was missing; GNU checking required MinGW `bin` on PATH for `windres`.
- Real FTP/SMB GNU release binaries were built and packaged, the resulting index signed, and both packages passed the client's `verify_release` example. A separate stdio `close` smoke check passed for both binaries. No live FTP/SMB server transfer was performed.
- The actual React plugin settings UI with simulated IPC verified installation, cancellation and offline/cache notices. New plugin and updated About screenshots were inspected. README links/language navigation were checked.
- Release archives and the signed catalog are local under ignored `plugin-release/`; the private signing key is outside the repository under the user's `.netape/publisher/` directory. No public catalog or GitHub release was deployed, so the public HTTPS download path still needs verification after publishing.
