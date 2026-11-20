# AI model configuration implementation

Goal: Adopt the EchoBird configuration workflow reviewed in `docs/echobird-model-config-review.md` while preserving Netape's styles, existing profiles and OS keyring.

1. Introduce an original provider preset directory with regional variants and Custom; retain editable endpoints and show the currently supported OpenAI Chat Completions protocol.
2. Replace the separate model input/selector with an accessible searchable editable combobox. Use shared input/menu styles, a portal that flips above when needed, keyboard selection and manual IDs. Keep refresh/paste actions inline.
3. Add draft catalog/test APIs in Rust. Normalize URLs, bound network responses, reuse a saved key only for the saved endpoint, cache catalogs by endpoint/credential fingerprint, and distinguish connectivity from actual model response. No test or refresh implicitly saves settings.
4. Guard async results by source/profile revision. Changing endpoint or key invalidates visible catalogs and tests. Switching profiles preserves unsaved drafts; model IDs remain unchanged unless explicitly selected.
5. Show model-count/cache age, response/connectivity latency and actionable failures. Keep Save explicit and reuse existing keyring persistence and defaults.
6. Test endpoint normalization, cached catalog isolation, temporary HTTP fixtures, draft settings behavior and keyboard/portal interaction; build frontend before desktop checks.

This implements provider/model configuration, not EchoBird account login, quota routing, native Anthropic or local inference lifecycle. All code is authored for Netape; no EchoBird source is copied.
