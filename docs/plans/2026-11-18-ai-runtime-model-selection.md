# Choose models in AI assistant

Service setup saves an endpoint, credentials and an optional default model. Companion shows every saved service and requires selecting a model before sending. Its compact picker loads credential-scoped cached/fresh model catalogs, supports search, refresh, keyboard selection and manual model IDs. Existing defaults remain usable, and each terminal tab remembers its override per service endpoint without persisting the override to settings.

Rust resolves credentials and endpoint exclusively from the saved service. The chat command accepts an optional model override, trims it and rejects empty, overlong or control-character IDs before building the provider request; no endpoint, key or global config is changed by model selection. Legacy calls without an override continue using the saved default.

Validation: production build and 31 Node tests passed. Rust ai test target compiled with GNU toolchain; fixture browser checks covered blank-model save, model selection and actual request override, service switching, manual fallback, stale catalog rejection, cache-first fetch and refresh, Escape, and narrow/light layouts. No real provider credentials were used. The existing Windows test-executable entrypoint issue prevents running Rust tests on this machine.
