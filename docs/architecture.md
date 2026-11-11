# Lokvyn Architecture Draft

**Status: Draft for review.** This document describes the current implementation and proposes boundaries for the Ollama-focused desktop client. It does not finalize the product scope in [Issue #1](https://github.com/Weiki886/lokvyn/issues/1), nor does it claim that unresolved decisions have been accepted.

## Product Boundary

The current application can detect a local Ollama service, list installed models, refresh the list, and display selected model metadata. These are implemented capabilities, not a final decision about the complete first-release feature set.

The application currently targets `127.0.0.1:11434`. It does not start Ollama, manage model files, provide chat, or persist conversations or settings. Whether chat, model downloads or deletion, history, or a configurable service address belong in the first release remains open in Issue #1. Other model services are future possibilities only; a generic provider framework is not part of the current implementation.

macOS is the documented development and CI environment. Windows, Linux, release packaging, signing, and distribution have not been confirmed or validated.

## Technology Decisions

| Area | Current choice | Rationale and boundary |
| --- | --- | --- |
| Desktop shell | Tauri 2 with Rust | Provides the native window and a Rust-owned local-service request boundary. |
| User interface | React and TypeScript | Owns presentation, navigation, and transient loading, success, empty, and error states. |
| Persistence | None | Current views read live Ollama responses and do not require a local database. Revisit only if an accepted feature needs durable state. |
| Build and checks | npm, Vite, TypeScript, Vitest, Cargo | Lockfiles and macOS CI are in place; the documented commands are listed in the README. |

These are the choices reflected by the merged implementation. A future design change still requires review against the product requirements and target platforms.

## Current Responsibilities and Data Flow

1. The React UI invokes Tauri commands and renders the returned connection version, model names, and available details. UI state is transient; the service response is the source of truth.
2. Rust owns all Ollama HTTP requests. The current commands call `GET /api/version`, `GET /api/tags`, and `POST /api/show` on the fixed loopback address.
3. The Rust layer validates the expected response fields and maps request failures to a generic unavailable error. Model details are limited to format, family, parameter size, and quantization level; absent values are omitted.
4. The UI distinguishes connection failure from an empty model list, supports retry and refresh, and allows navigation between the list and a selected model's details.

The current request flow is:

`User action -> React state -> Tauri IPC command -> Rust HTTP client -> local Ollama -> validated response -> React state`

The Rust client disables proxy use and redirects, uses a three-second request timeout, and bounds response bodies (4 KiB for the version response and 4 MiB for model-list and detail responses). These limits are implementation facts and should be revisited if supported Ollama responses require different bounds.

## Security and Privacy

- Requests are restricted in application code to the loopback Ollama endpoint; the address is not user-configurable. Do not add remote targets or address overrides without product and security review.
- No Ollama request is made directly from the webview. The Rust layer validates service data, disables redirects and proxies, applies time and response-size bounds, and returns only the fields required by the UI.
- The current Tauri configuration declares a restrictive content security policy. Any new webview capability or network destination must be justified and covered by review and tests.
- Model names and service responses are untrusted input. Do not log model content, credentials, or sensitive user data. The current application does not add telemetry or send data to third parties.
- The application does not store credentials, model content, conversations, or settings.

## Validation Strategy

- Keep routine frontend and Rust tests independent of a running Ollama service by using controlled responses.
- Cover connection success and failure, timeouts, rejected redirects, response-size limits, malformed payloads, empty model lists, refresh, missing detail fields, and detail failures.
- The ignored Rust integration tests can compare connection, model-list, and model-detail results with a real local Ollama service. Record the service version and platform when running them.
- Treat frontend unit tests, Rust tests, Tauri builds, native-window checks, and real-service checks as separate evidence. A successful web build does not prove that native IPC or a packaged application works.
- CI currently runs the repository checks and a Tauri build on macOS. It does not establish support for other operating systems or distribution formats.

## Open Decisions

The following decisions remain open and must be resolved through product or architecture review before the related scope is treated as committed:

- **First-release scope (Issue #1):** whether to include chat, model download or deletion, conversation history, or a configurable Ollama address.
- **Supported platforms and distribution (Issue #1):** whether Windows or Linux are targets, and whether installers, signing, or release distribution are required.
- **Network boundary:** whether the fixed local-only connection remains the permanent product boundary. Remote Ollama access would change the privacy and security assumptions and is not implied by future provider extensibility.
- **Future service integrations (Issue #2):** no generic adapter, provider registry, plugin system, or non-Ollama service is implemented. Reassess the extension boundary when a concrete second-service requirement exists.
- **Native UI acceptance:** automated browser tests do not exercise Tauri IPC or verify the native window. The desktop workflow and real-service integration still need explicit acceptance on a confirmed target environment.

Issue #2 should remain open until the architecture is reviewed against the decisions in Issue #1 and its acceptance criteria are explicitly confirmed.
