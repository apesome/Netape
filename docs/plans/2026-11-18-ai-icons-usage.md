# AI assistant model icons and usage

Use the existing EchoBird MIT provider and model-family icon assets locally in model setup, service cards, runtime service/model picker and current model. Keep relay presets excluded. Preserve source attribution for assets and adapted provider modules at upstream 7afc3d045bc789758343ae02ba17aa5bf344668c.

Use EchoBird's ten API-key-only balance/quota adapters behind Netape's saved profile ID and system keyring. Harden transport with no redirects, exact host matching and bounded responses. Additional login, team-access and AK/SK credential subsystems are outside this iteration. Unknown or unavailable quotas remain unknown. Display selected provider balance or remaining window percentage/reset time in expandable details, with refresh and service-scoped stale result guards.

Parse token usage from OpenAI-compatible stream usage chunks and Anthropic message_start/message_delta, including cached input tokens. Display the latest request's reported counts without estimating account credit or cost. Keep default profile/model selection and chat permission rules unchanged.

Validation: frontend build, 34 Node tests, Rust test target compilation, mock browser checks for assets, balance/quota/token rendering, refresh/failures/unsupported providers, service cards and stale result isolation. Live credentials not used. Windows Rust test executable startup remains blocked by a DLL entrypoint issue.
