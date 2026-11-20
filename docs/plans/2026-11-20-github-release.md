# GitHub Release Implementation Plan

**Goal:** Publish Netape source, Windows installer and independently versioned FTP/SMB plugins to `apesome/Netape`, and serve the signed catalog through GitHub Pages.

**Architecture:** Use one public repository, GitHub Releases for immutable versioned binaries, and GitHub Pages for the signed plugin catalog. A manually triggered Windows GNU workflow runs the same build and verification commands used locally. Signing material lives outside the repository and in a GitHub Actions secret.

**Tech Stack:** Git, GitHub CLI, GitHub Actions, Node.js, Rust GNU, Tauri NSIS, Ed25519.

## Execution

1. Verify the authenticated GitHub owner, create the public repository, inspect source and exclude credentials/build output.
2. Build the Windows NSIS installer; verify plugin packages with the client installer module and run the existing Node test suite.
3. Add a manual Windows release workflow and publishing documentation. Reject overwriting an existing app release; reuse a plugin release only when its existing archive exactly matches the new bytes.
4. Commit and push the current workspace, upload immutable application/plugin assets, then publish the signed catalog to Pages.
5. Download published assets and catalog, compare hashes and signatures, and report actual release URLs and remaining platform limitations.

## Validation

- Existing Node test suite and Rust installer suite.
- Production frontend build and Windows NSIS build.
- GitHub workflow syntax validation where tooling is available.
- Source upload excludes private keys, caches, local tooling and generated binaries.
- HTTPS download readback of Release assets and signed Pages catalog.
