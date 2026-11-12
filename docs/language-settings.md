# Language Settings

Issue: #19. Baseline: `066f29d` (merged desktop workspace, PR #18).

## Scope And Decisions

Add English and Simplified Chinese in Settings with immediate application-wide updates and a persistent local preference. Keep English as the initial default. Translate UI labels, states, tooltips, accessibility labels, sample catalog copy, and date formatting. Preserve model names and Ollama configuration values. Read the application version from Tauri metadata independently of the Ollama version.

Use a small translation dictionary and React state, the existing `Intl` formatters, webview local storage, and Tauri's existing `getVersion` API. No new dependencies, database, Ollama commands, or service behavior are needed. Only the main local window receives `core:app:allow-version`; no remote capability is granted.

## Implementation And Verification

1. Add behavior tests for Settings language selection, cross-view updates, reload persistence, and runtime version display. Initial red run: 19 existing tests passed, 2 new tests failed because the selector and runtime version were missing.
2. Implement the dictionary, persistent locale state, translated workspace, and runtime version lookup. First green run: all 21 tests passed.
3. Check reverse switching, unsupported preferences, version failure, catalog filters, and preservation of Ollama values. A second red run caught untranslated byte units and download labels (23 passed, 2 failed); use the selected locale for dates and complete the dictionary.
4. Final frontend suite: 25 tests passed. Formatting, lint, typecheck, Vite build, Cargo formatting, and Clippy passed. Rust tests: 10 passed; 4 local Ollama integration tests were ignored. The Tauri desktop build succeeded.
5. Playwright checked all seven views in both languages at 1320 x 820, 720 x 600, and 390 x 844 (42 combinations), including language switching and reload persistence. No page errors or horizontal container overflow remained. The 720px check exposed model-list overflow; stacking the model inspector below the list at the existing 900px breakpoint fixed it.

Browser checks used synthetic models and Tauri IPC fixtures. They validate presentation and browser reload persistence, not native IPC or persistence after a native application restart. Native desktop acceptance remains the manual checklist below.

## Manual Desktop Acceptance

Run `npm run tauri dev`. Open Settings, switch to Simplified Chinese, navigate the menus, then restart the app and confirm the choice remains. Switch back to English. Verify the footer and Settings application version match `src-tauri/tauri.conf.json`; the Ollama service version remains separate. Confirm an installed model's original name and configuration still appear unchanged.

If local storage is blocked, use English initially and allow changes for the current session. If version lookup fails, show a translated unavailable label without blocking navigation.
