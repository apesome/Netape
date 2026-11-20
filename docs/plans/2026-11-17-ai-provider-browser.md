# AI provider browser implementation plan

**Goal:** Show the model form and provider options together, and support all text-model provider editions from EchoBird's current API directory.

**Architecture:** Retain the inline settings page and existing credential vault. Put the form on the left and a searchable provider rail on the right, with independent hidden-scrollbar scrolling and fixed page chrome. Add backwards-compatible protocol/provider identity fields to profiles, native Anthropic request/response/stream support and protocol-scoped discovery caches. Google and other compatible endpoints continue to use Chat Completions. Preserve endpoint credential isolation, request cancellation and bounded responses.

1. Import an attributed snapshot of EchoBird's model provider facts (exclude relay presets), grouped into providers and editions; retain Netape's existing API/local presets. Offer Meta Llama through an explicitly named compatible provider because the source has no direct Meta endpoint. Do not add speech/account-login subsystems to the terminal text assistant.
2. Add protocol-aware normalization, auth, model requests, streaming and discovery in Rust. Migrate existing profiles to OpenAI compatibility without changing their endpoint or key. Test native Anthropic with local HTTP fixtures.
3. Extend the frontend catalog, suggestions, profile identity and credential guards. Replace the provider chooser page with a right-hand rail alongside the editor. Keep shared controls and responsive layouts.
4. Verify provider/edition coverage and native/compatible transport, then browser-check selection, edition/protocol switching, search, saving, layout and credentials with a mock bridge. Build frontend followed by tests and the desktop executable.

User refinements: new entries select Custom API by default; selecting Custom API also resets the display name. Exclude all relay presets; retain OpenRouter as a model provider, Meta through its explicitly disclosed OpenRouter route, and Ollama local.
