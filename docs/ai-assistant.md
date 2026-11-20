# Terminal AI assistant

Open the sparkle button after **Properties** in the terminal toolbar. The button also appears in the floating toolbar when the status bar is hidden. Local terminals have the same actions in their upper-right corner.

Each terminal tab has an independent conversation and draft. AI, properties, notes and monitoring share one right drawer. Switching drawers hides the chat without discarding its messages; closing a terminal cancels its AI requests.

## Configuration

In **Settings → AI assistant**, add a service to open the model form on the left and searchable provider options on the right. The editor header and save buttons remain fixed; each column scrolls independently without visible scrollbars. New services select Custom API by default, and selecting Custom API restores the initial blank endpoint, model and key, the default protocol and display name, and the top of the form. Provider identity remains fixed above the scrolling form. The two probe buttons and their results appear below the model field. The directory includes all 55 provider editions from the EchoBird snapshot (35 provider groups), two additional Qwen API editions and Ollama local, for 36 selectable provider groups. Relay presets are excluded. Regional and plan editions appear in the edition selector. OpenAI Chat Completions and native Anthropic Messages are supported; existing profiles default to OpenAI compatibility. Meta Llama uses an explicitly disclosed OpenRouter route because the source has no direct Meta API endpoint.

The default model ID is optional: save only the service endpoint and credentials, then choose a model from AI assistant. Existing configured model IDs remain defaults. The model field combines free typing, filtered suggestions, keyboard navigation, paste and refresh. Its menu opens above the field when space below is limited. A manually entered ID remains valid even when the service has no model-list API. Choosing a provider clears the old model ID and uses an explicit preset when the selected edition provides one; otherwise select a discovered ID or enter one manually.

**Refresh models**, **Test connection** and **Test model response** operate on the unsaved draft; only **Save** persists profiles and keys. Connection checks the selected protocol's model-list endpoint, while model-response testing sends a small chat request and may incur provider usage charges. Both show success/failure and elapsed milliseconds separately. Failed discovery does not block manual model entry. The Ollama preset uses `http://localhost:11434/v1`.

Catalogs are cached in backend memory for ten minutes, scoped to endpoint, protocol and credential fingerprint. Reopening an existing profile reads the cache without making a network request. New local profiles or new profiles with a supplied key can discover after an 800 ms debounce. Outdated requests cannot overwrite the current endpoint's list or test state. Complete `/chat/completions`, `/messages` and `/models` URLs are normalized back to their API base; other path prefixes are retained.

Requests use the selected Chat Completions or Anthropic Messages endpoint, streamed SSE responses and a configurable output-token limit and timeout. This is an API-key integration, not a login to a ChatGPT/Claude subscription. Providers must support the selected text model on the configured endpoint. Google model discovery uses its native paginated catalog and strips the `models/` prefix for compatible chat requests. Speech transcription and subscription-account login are outside this terminal text assistant.

API keys are stored in the operating system credential store (Windows Credential Manager, macOS Keychain, or Linux Secret Service). Only profile metadata is stored in Netape's settings database. Saving a key fails visibly if the credential store is unavailable; keys are never silently saved in plaintext settings. Empty input preserves a saved key unless **Remove credential** is selected. Removing a profile deletes its stored credential.

Changing an endpoint or protocol never automatically sends the old saved credential to the new address. Enter a credential explicitly for that address, or explicitly clear it to use a keyless service. Discovery/test drafts do not write to the credential store, and cache entries contain no plaintext keys.

## Companion panel

The companion now follows the compact header / transcript / bottom-composer interaction reviewed in Netcatty, implemented independently with Netape's theme and configured model profiles. The header provides new conversation, searchable history, copy-to-Markdown, settings and close. The current terminal, cwd and connection status remain visible. Recent conversations are scoped to the current host or local terminal category.

The bottom composer opens a service/model picker. All saved services appear, including those without a default model. Select a service to load its credential-scoped cached catalog or fetch a fresh list; search, keyboard selection, refresh and manual IDs are supported. Unavailable model-list APIs do not prevent manual selection. Each terminal tab remembers a model per service endpoint while it remains open. Changing that choice does not write the service configuration. Requests use the selected model through a validated transient backend override, and sending requires a model. The composer shows the collaboration permission and offers selection/recent-output attachments, automatic context and expansion. Removing the selected profile chooses another configured service using the saved active profile first. Starter tasks prepare a draft and previewable context without sending it. Attachment sources are redacted, deduplicated and bounded before sending.

User messages appear as bubbles; assistant text includes code actions, copy and regenerate. Retry preserves the latest user question and attached context while replacing an incomplete answer. The same stop action cancels model generation or an active managed SSH command. Confirmed SSH commands display running/completed/failed/stopped states; replaced sessions discard late output. Local terminal commands still require explicit confirmation and manual output reading after completion.

Companion validation: production build and 31 Node tests passed. Mock-bridge browser checks covered configured and unconfigured services, model switching/fallback, streaming, retry, cancellation, context redaction, history search, draft retention, command confirmation/output, late-session callbacks, suggest-only permissions and 300 px dark/light layouts. These checks do not establish real-provider network availability.

## Terminal context

Attach the selected text or recent output manually, or enable automatic recent output per conversation. Host name, protocol and tracked directory can be included separately. Host passwords, keys and connection objects are never attached. Common token/password assignments, bearer tokens and private-key blocks in shared output are redacted, but output must still be reviewed before sharing. Context sent to an external model leaves the computer through the configured provider.

Saved conversations stay in the local Netape SQLite database, are listed by host/local terminal type, and are opened explicitly through **History**. Conversation buffers and history are bounded. Disable history or use **Clear all chat history** to remove stored messages. Messages and terminal context in history are not encrypted by this feature; API keys are stored separately in the system credential store.

## Commands

Shell code blocks provide actions according to the configured permission:

- **Suggestions and copy only**: no terminal input.
- **Paste without Enter** (default): uses bracketed paste when supported, or converts line breaks to spaces otherwise. Press Enter yourself after reviewing the terminal.
- **Execution after each approval**: shows the full editable command and target before every execution. Changing tabs, switching drawers, reconnecting or removing execution permission invalidates the review.

For SSH, execution uses a separate command channel on the current connection and an explicitly reviewed absolute directory. It does not inherit a shell's temporary variables, virtual environment, aliases or `sudo` session. Output, exit status and truncation are shown, and **Analyze result with AI** sends the result for follow-up. A timeout, output limit or stop requests termination and closes the command channel; a remote program may handle or ignore termination signals.

Local/WSL/Telnet execution types the command and Enter into the current terminal after approval. It requires an idle shell prompt; fullscreen terminal programs are rejected. Read recent terminal output after completion to send the result back to AI. This first version offers reviewed command actions rather than autonomous multi-step execution or automatic file edits.

## Verification

The implementation includes tests for bounded/redacted context, terminal paste behavior, independent drawer state, incremental Unicode SSE decoding, cancellation, provider error sanitization, a local HTTP-compatible stream and a disposable system-credential round trip. Browser fixtures exercise chat, profile settings, terminal context, reviewed SSH/local execution and tab isolation without connecting to user hosts or sending data to an external model.

Provider browser validation (2026-11-17): frontend production build and 26 Node tests passed. Browser checks used a mock Tauri bridge for default Custom selection, synchronized names, provider search, edition selection, native protocol persistence, saved-key isolation, independent hidden-scrollbar scrolling and a 640 × 560 viewport. Rust transport tests compile; the local GNU test executable cannot start on this machine (STATUS_ENTRYPOINT_NOT_FOUND), so runtime fixture results and real-provider credentials remain unverified.

Optional-model validation: browser fixtures saved a service without a model ID, selected/search-filtered models from two services, checked the actual chat request model, confirmed each service choice survives switching, tested manual IDs after discovery failure, stale catalog rejection, cache/manual refresh and light/narrow layouts. Rust tests for optional defaults, override validation and unchanged saved profiles compile; runtime execution remains blocked by the previously observed Windows DLL entrypoint error.

## Model icons and usage

AI assistant is the product name throughout the UI. Model icons are bundled locally for every selectable provider and recognized model families; model IDs take precedence over gateway brands. The applicable MIT copyright and license notice is in [licenses/EchoBird-MIT.txt](../licenses/EchoBird-MIT.txt).

Saved-service cards and the assistant composer offer an expandable Usage & balance view. Opening it queries the saved service using its OS-vault API key; refresh is explicit, with a throttled refresh after a chat while expanded. Adapters from EchoBird cover DeepSeek, Kimi Coding, Moonshot, MiniMax, Novita, OpenCode, OpenRouter, SiliconFlow, StepFun and Zhipu. Query availability depends on the service region, plan and key permissions; SiliconFlow domestic querying is retired in the source implementation. Other services, relay presets and providers requiring login sessions or separate AK/SK are not queried. No balance or percentage is estimated. OpenRouter inference keys expose their spending limit when configured, rather than account-level management credit.

Usage requests run in Rust, use exact HTTPS host matching, reject redirects and bound the response. Credentials and response bodies are never returned in error messages. UI results are discarded when switching services. This is separate from per-request tokens returned by OpenAI-compatible and Anthropic streams; supported responses display input/output counts. Token usage is transient, not a billing ledger or cost estimate.

Validation: 34 Node tests passed, including complete provider asset coverage and SVG checks. Browser fixtures verified all 36 provider icons loaded, family logos, service card/assistant balances, quota bars, unsupported/failed query states, refresh, stale service response rejection and request tokens. GNU Rust test targets compile, including adapted provider fixtures, HTTP redirect/error tests and stream usage parsing. Real supplier balances remain unverified without user credentials; the local test executable still encounters the previously observed DLL entrypoint problem.
