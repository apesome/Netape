# Terminal AI assistant refinement

Reference: Netcatty repository checkout 3289c0deca6fdbd9d72494c0a6e9b42c5d787ee2 and current public AIChatPanelContent.tsx (read 2026-11-17). Reviewed its compact header, history/recent views, composer provider switcher, context controls and message/action presentation. Implement these interactions independently in Netape using its own shared theme, assistant-ui runtime and Rust transport.

- Keep a fixed compact header with new conversation, history, settings and copy-to-Markdown actions. Show the actual terminal target, cwd and connection status below it.
- Use a quiet transcript with user bubbles and assistant text, copy-response actions, regeneration and jump-to-latest. Add three starter tasks which prepare a draft and previewable terminal context; the user sends explicitly.
- Move configured provider/model selection into a bordered bottom composer. Preserve per-tab selection and select a usable fallback if configuration changes. Show the existing collaboration permission with a settings link; commands continue to use the configured suggest/paste/confirm policy.
- History is a dedicated searchable view scoped to this terminal; recent conversations appear in the empty view. Retain the unsent draft when opening and closing history.
- Redact, deduplicate and bound terminal attachments, keep host sharing and automatic output governed by collaboration settings. Model/protocol secrets remain in Rust and the OS vault.
- Stop covers model generation and an active managed SSH command. Reject late output from a cleared or replaced session; clear pending approvals on session/permission/visibility changes. Guard send, regeneration and conversation switching while model or managed command work is active.
- Retain explicit edited-command confirmation, independent SSH execution semantics and local terminal result reading. This refinement does not add external CLI authentication, a multi-terminal agent loop, file tools or automatic command execution.

Validation: helper tests plus browser fixtures for empty/unconfigured/configured states, model switching, context redaction, streaming, stopping, retry, history/draft retention, permissions and command review, session changes and narrow layouts. Production TypeScript/Vite build.

Completed validation: 30 Node tests and production TypeScript/Vite build passed. Browser fixture verified context redaction and explicit starter send, paste/regenerate/Markdown copy, history search and draft retention, Anthropic service selection, model cancellation, edited SSH command execution and stop, invalidated-session late output rejection, suggestions-only mode, request error/retry, unconfigured setup and fallback, and 300 px light/dark layouts. No real API credentials or user SSH hosts were used.
