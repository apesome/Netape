# macOS and Linux Release Implementation Plan

**Goal:** Add macOS Intel/Apple Silicon and Linux x64/ARM64 packages to v1.0.0.

**Architecture:** Native GitHub-hosted runners build each target independently. A single publishing job checks all checksums, appends immutable installers and FTP archives to existing releases, signs the merged catalog, and deploys Pages. Existing Windows files remain byte-identical. Each platform includes a source commit manifest because the original v1.0.0 tag predates cross-platform packaging fixes.

**Tech Stack:** Tauri 2, Rust 1.95.0, Node 22, GitHub Actions, Ed25519.

1. Add a native four-target workflow, Linux system libraries and the macOS icon configuration.
2. Stage installers with SHA-256 checksums and provenance; test malformed paths, altered files and catalog conflicts.
3. Publish only after every target succeeds. Compare existing assets before reusing them; replace only the renewable signed catalog pair.
4. Run the workflow, repair actual compiler/bundler errors, verify published downloads and the live signed catalog.
5. Update multilingual download instructions with actual formats, architectures and concrete platform limitations.
