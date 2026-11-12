# Lokvyn Architecture Draft

**Status: Proposed MVP decision for review.** This document records the current implementation and the selected initial product boundary for review in [Issue #1](https://github.com/Weiki886/lokvyn/issues/1). The implementation remains Ollama-focused; this decision does not authorize a generic provider framework.

## Product Boundary

The current application can detect a local Ollama service, list installed models, refresh the list, display selected model metadata and read-only configuration, and load or unload installed models in memory. Loaded state comes from Ollama's running-model list and can change outside the app or after Ollama's keep-alive timeout.

The application currently targets `127.0.0.1:11434`. It does not start or stop the Ollama service, manage model files, provide chat, or persist conversations. The English or Simplified Chinese language preference is stored locally in the webview; no other settings are persisted. Model lifecycle controls affect only whether an installed model is loaded in Ollama memory. Whether chat, model downloads or deletion, history, or a configurable service address belong in the first release remains open in Issue #1. Other model services are future possibilities only; a generic provider framework is not part of the current implementation.

The MVP target is macOS, matching the documented development and CI environment. Windows and Linux are not MVP targets. The MVP is a developer-run desktop application; installers, signing, and public distribution are deferred until there is a concrete release requirement.

## Technology Decisions

| Area | Current choice | Rationale and boundary |
| --- | --- | --- |
| Desktop shell | Tauri 2 with Rust | Provides the native window and a Rust-owned local-service request boundary. |
| User interface | React and TypeScript | Owns presentation, navigation, and transient loading, success, empty, and error states. |
| Persistence | Webview local storage for language only | The `lokvyn.locale` preference survives restarts. Ollama data remains live; no database, conversations, or credentials are stored. If storage is unavailable, the selection lasts for the current session. |
| Build and checks | npm, Vite, TypeScript, Vitest, Cargo | Lockfiles and macOS CI are in place; the documented commands are listed in the README. |

These are the choices reflected by the merged implementation and the selected MVP boundary. Changes to product scope or target platforms require a separate review.

## Current Responsibilities and Data Flow

1. The React UI invokes Tauri commands and renders the returned connection version, installed models, running models, and available details. UI state is transient; Ollama responses are the source of truth.
2. Rust owns all Ollama HTTP requests. The current commands call `GET /api/version`, `GET /api/tags`, `GET /api/ps`, and `POST /api/show` on the fixed loopback address. Load/unload requests use the documented empty-message `POST /api/chat` operation.
3. The Rust layer validates expected response fields and maps request failures to a generic unavailable error. Read-only details include model metadata, parameters, template, system prompt, and bounded scalar model-info fields; absent or out-of-bound fields are omitted.
4. The UI distinguishes connection failure from an empty model list, supports retry and refresh, reconciles each lifecycle action against `/api/ps`, and allows navigation between the list and a selected model's details.

The current request flow is:

`User action -> React state -> Tauri IPC command -> Rust HTTP client -> local Ollama -> validated response -> React state`

The Rust client disables proxy use and redirects, uses a three-second request timeout for routine reads and a ten-minute bounded timeout for model lifecycle requests, and bounds response bodies (4 KiB for the version response, 1 MiB for running-model status, 64 KiB for lifecycle responses, and 4 MiB for model-list and detail responses). These limits are implementation facts and should be revisited if supported Ollama responses require different bounds.

## Security and Privacy

- Requests are restricted in application code to the loopback Ollama endpoint; the address is not user-configurable. Do not add remote targets or address overrides without product and security review.
- No Ollama request is made directly from the webview. The Rust layer validates service data, disables redirects and proxies, applies time and response-size bounds, and returns only the fields required by the UI.
- The current Tauri configuration declares a restrictive content security policy. Any new webview capability or network destination must be justified and covered by review and tests.
- Model names and service responses are untrusted input. Do not log model content, credentials, or sensitive user data. The current application does not add telemetry or send data to third parties.
- The application does not store credentials, model content, conversations, configuration responses, or settings.

## Validation Strategy

- Keep routine frontend and Rust tests independent of a running Ollama service by using controlled responses.
- Cover connection success and failure, timeouts, rejected redirects, response-size limits, malformed payloads, empty model lists, refresh, lifecycle request outcomes, running-state reconciliation, missing detail fields, and detail failures.
- The ignored Rust integration tests check connection, installed models, running models, and model details against a real local Ollama service. Record the service version and platform when running them.
- Manually verify load, `/api/ps` state, unload, and refreshed state in the native Tauri app only when changing local model runtime state is safe. Keep this evidence separate from browser tests and read-only integration tests.
- Treat frontend unit tests, Rust tests, Tauri builds, native-window checks, and real-service checks as separate evidence. A successful web build does not prove that native IPC or a packaged application works.
- CI currently runs the repository checks and a Tauri build on macOS. It does not establish support for other operating systems or distribution formats.

## MVP Decisions

The initial MVP is a desktop manager for models already available from a local Ollama instance:

- **Included:** connection status and retry; installed-model listing and refresh; per-model loaded status and load/unload controls; read-only model metadata and configuration; loading, empty, and failure feedback.
- **Excluded:** chat, model download or deletion, conversation history, settings persistence, configurable or remote Ollama addresses, other model services, and a generic provider framework.
- **Target:** macOS for MVP development and validation. This is not a claim of Windows or Linux support.
- **Distribution:** run from the documented development workflow. Installers, code signing, and public distribution are deferred.
- **Storage:** no database. Current views use live service responses and transient UI state.
- **Network boundary:** Rust makes bounded requests to `127.0.0.1:11434`; do not add remote targets or address overrides without a new product and security review.

## Remaining Validation

- Automated browser tests do not exercise Tauri IPC. Native app startup and mocked command tests do not replace manually checking lifecycle controls and configuration in the Tauri window on macOS.
- Real-service integration tests require a running local Ollama instance and must be recorded separately from CI and unit-test results.
- Revisit the deferred scope only when a concrete requirement is raised; future service integrations must be designed from that requirement rather than anticipated in the current code.

Issues #1 and #2 can be closed when this MVP boundary and the architecture are accepted through review. Remaining validation items do not expand the product scope.
