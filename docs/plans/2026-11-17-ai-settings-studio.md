# AI settings studio implementation plan

**Goal:** Replace the long AI configuration form with model service cards, a provider chooser and focused editing, while keeping Netape's existing controls and theme.

**Architecture:** Keep the current AI config, credential vault and catalog/probe commands. Separate model management from collaboration preferences. Service changes save independently from pending preference edits; cancelling the editor restores its draft. Addition, editing and confirmation now replace the right-hand settings page, with no nested modal. Cards fit three per row at the standard settings width. Remove default-service controls and start with an empty service list.

**Tech stack:** React, TypeScript, existing CSS variables, CustomSelect and AiModelPicker.

1. Add shared provider marks and an accessible modal in `src/components/AiSettingsUi.tsx`.
2. Refactor `src/components/AiSettings.tsx` into service cards, provider selection, service editing and collaboration preferences. Preserve credential-change protections and stale-response guards. Confirm removal and history clearing.
3. Add scoped responsive styles in `src/styles.css`, including dark/light themes, clear focus indicators, testing, empty and error states. Keep the current settings width.
4. Verify the actual UI with fake Tauri commands: add/cancel/edit/save/default/delete, draft credential tests, preferences isolation and modal focus. Run provider/domain checks and the frontend build.
5. Build the desktop executable after frontend resources finish; verify it embeds the new assets and report the output path.

## Validation

- Browser checks with a fake Tauri bridge passed: model response testing, default selection, add/cancel/edit/save, discovery and manual model selection, credential review after endpoint changes, stale model-test responses, failure/retry, isolated preference drafts, removal and history confirmation, focus containment, Escape handling, background restoration, narrow single-column layout and light theme.
- The existing AI and provider tests passed (7 tests). No real credentials or provider requests were used for UI validation.

## Follow-up refinement

- Removed the large AI heading, decorative descriptions, default-service badge/actions and empty starter service. Reduced cards to three columns at the normal settings width, with two/one-column fallbacks.
- Added an inline explanation of the system prompt. Existing configured services and stored credentials are preserved; only the exact untouched starter without a stored key is discarded.
- Service configuration and confirmations now use `AiSettingsPage` in the existing settings panel. The chat panel handles an empty configuration. Rust validation accepts zero profiles; removing the last service is supported.
- Browser checks passed for three columns without overflow, removed headings/default controls, inline add/edit/test/save/cancel, isolated preference drafts, deleting all services, adding a first service again, and narrow/light layouts.

## Automatic prompt language

- Built-in prompts share one JSON source between the editor preview and Rust request handling. Empty prompt configuration represents automatic mode. The current interface language is supplied on each AI request, including when the app is following the operating-system language.
- Chinese, English, Japanese and German templates are available. The exact legacy built-in English text migrates to automatic mode; custom content remains unchanged. Settings includes an automatic/custom indicator and a restore action.
- Browser checks passed for live language switching, custom preservation and saving, restore/save of automatic mode, and the shared input focus border.
