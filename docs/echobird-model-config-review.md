# EchoBird model configuration review

Reviewed on 2026-11-16 against the public `main` branch. GitHub reported head `e1510b8361d601fb2535f63c4668715360efe4bb` during the review; source files were read from `main`, which may advance independently.

## Conclusion

Adopting the configuration interaction is feasible: EchoBird and Netape both use React/TypeScript with a Tauri/Rust backend. Netape now implements a provider directory, a single editable searchable model field, cached draft discovery and separate connectivity/model-response test status. It retains its OpenAI-compatible streaming client and OS credential store. The implementation follows the reviewed interaction design with original Netape code; it does not import EchoBird's account/proxy subsystem.

## Evidence and fit

| EchoBird behavior | Source | Fit for Netape |
| --- | --- | --- |
| Built-in provider/relay directory with API URLs, grouped regional/plan editions and preset model IDs where discovery is unavailable | [modelDirectory.json](https://github.com/edison7009/EchoBird/blob/main/src/data/modelDirectory.json) | Good: offer provider presets while preserving custom URLs. Check current vendor endpoints when adding presets. |
| One model ID field supports typing an arbitrary ID, browsing/searching discovered IDs, refresh, paste, keyboard navigation and a portal menu that flips above the input | [ModelIdCombobox.tsx](https://github.com/edison7009/EchoBird/blob/main/src/components/ModelIdCombobox.tsx) | Good: replace Netape's separate model input and selection box with one control styled like Netape's other fields. |
| Cached catalogs, debounced discovery for new entries, stale-response rejection and manual model fallback | [ApiModelFields.tsx](https://github.com/edison7009/EchoBird/blob/main/src/pages/ModelNexus/ApiModelFields.tsx) | Good: avoid requiring Save before discovery; accept a draft config in Rust without persisting its key and never apply a response to a different endpoint. |
| Discovery normalizes endpoints, handles OpenAI/Anthropic/Google catalogs, auth and pagination; cache key includes endpoint and credential identity | [upstream_model_catalog.rs](https://github.com/edison7009/EchoBird/blob/main/src-tauri/src/services/upstream_model_catalog.rs) | Useful but needs a small adapter layer. Listing a provider's models does not by itself make its inference protocol supported. |
| Model records carry display name, model ID, primary/Anthropic URLs, source/type and per-protocol test/latency results | [model.rs](https://github.com/edison7009/EchoBird/blob/main/src-tauri/src/models/model.rs), [model_manager.rs](https://github.com/edison7009/EchoBird/blob/main/src-tauri/src/services/model_manager.rs) | Suitable for persistent connection/response status and latency. Separate connectivity success from an actual model response. |
| Chat transport explicitly distinguishes OpenAI and Anthropic paths | [llm_client.rs](https://github.com/edison7009/EchoBird/blob/main/src-tauri/src/services/llm_client.rs) | Native Anthropic requires implementing request, stream, errors, messages and tool mapping in Netape. A second URL field alone is insufficient. |
| Account-bound models use provider/account IDs and a separate account/proxy subsystem | [AccountModelFields.tsx](https://github.com/edison7009/EchoBird/blob/main/src/pages/ModelNexus/AccountModelFields.tsx), [account_model_sources.rs](https://github.com/edison7009/EchoBird/blob/main/src-tauri/src/services/account_model_sources.rs) | A separate optional project. Netape has no matching account lifecycle/credential refresh/proxy infrastructure. API-key configuration can be improved independently. |

## Recommended Netape scope

1. Configuration UX: provider presets plus Custom; a combined searchable/editable model field; refresh and connection test next to model; last test status and latency. Keep numeric/text/dropdown controls on Netape's shared styles.
2. Draft model discovery: send a transient draft to Rust, read an existing key from the system store when unchanged, normalize endpoints, cache results and reject stale responses. Do not silently switch a user's selected model or route terminal context to another provider.
3. Protocol support: retain OpenAI Chat Completions initially. Add native Anthropic or Responses only together with backend adapters, streaming/cancellation tests and a visible protocol selector. Google catalog support alone is not native Gemini chat support.
4. Keep Netape's OS keyring. EchoBird uses a separate AES-GCM secret envelope and local key material; migrating secret storage is unnecessary for adopting its UI or catalog design.
5. Account login, quotas, smart routing/failover and local model lifecycle are optional later modules. They are not prerequisites for the terminal companion and should not be copied wholesale.

## License

The repository's [LICENSE](https://github.com/edison7009/EchoBird/blob/main/LICENSE) is MIT, copyright 2026 edison7009 and EchoBird contributors. Directly copying or adapting its code requires retaining the relevant copyright/license notice. The configuration workflow here was implemented independently, using Netape's shared styles and backend.
