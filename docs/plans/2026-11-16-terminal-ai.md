# Terminal AI Implementation Plan

**Goal:** Add a per-terminal AI companion with configurable OpenAI-compatible providers, streamed chat, terminal context and reviewed command actions.

**Architecture:** assistant-ui renders a custom external runtime. Rust owns HTTP requests, credentials, cancellation and independent SSH command execution. AI joins the existing single-drawer state; chat components remain mounted per terminal, and each conversation gets a UUID rather than a reusable tab identifier.

**Tech Stack:** React 18, assistant-ui, react-markdown, Tauri channels, reqwest, system keyring, SQLite.

1. Add validated AI settings with multiple profiles, keyring secrets, model discovery, connection testing and history storage. Secrets never appear in public settings or prompts.
2. Implement OpenAI-compatible streaming chat in Rust with cancellation, timeout, bounded context and incremental SSE parsing. Test split UTF-8/SSE records and error responses.
3. Extend terminal APIs with selection, recent plain-text output and explicit input methods. Keep display writes distinct from shell input. Verify local and SSH bindings.
4. Add per-tab chat drawer after Properties, mutually exclusive with existing drawers. Provide Markdown/code actions, stop/retry/new/history, explicit context attachment and per-provider selection.
5. Add reviewed command actions: copy, paste without Enter, and independent SSH execution with explicit working directory, bounded output, timeout and cancellation. Return results to chat for follow-up. Interactive/local commands can use the existing terminal with explicit review and manually attached output.
6. Add AI settings navigation, provider editing, execution policy, context/history limits and connection test. Use system credentials only and surface storage errors.
7. Verify frontend and backend unit tests, streamed responses against a local fake compatible API, terminal/session isolation, drawer exclusivity, settings and cancellation in browser fixtures. Build frontend before checking the desktop crate.

Decisions: no Node sidecar; no automatic command execution; tool output is untrusted context; no passwords/private keys in host metadata; do not claim an independent SSH command inherits interactive shell state. Existing user changes stay intact.
