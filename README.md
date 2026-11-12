# Lokvyn

Lokvyn is a desktop GUI focused on local Ollama. It checks the connection, lists installed models with refresh and retry, shows available model sizes and update times, displays read-only model metadata and configuration, and loads or unloads installed models in Ollama memory. Chat, model downloads or deletion, history, remote endpoints, and other services are out of scope for the MVP.

The application connects only to `127.0.0.1:11434` and does not start Ollama. Start Ollama separately to see the connected state. The address is not configurable.

## Development

The initial development environment is macOS. Other operating systems and distribution formats are not yet confirmed or validated. Install Node.js 24, Rust and the macOS prerequisites described in the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/), including Xcode Command Line Tools.

```sh
npm ci
npm run tauri dev
```

The desktop development command starts a local Vite server and opens the Tauri window. It does not require Ollama to be running.

## Checks

```sh
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo test --manifest-path src-tauri/Cargo.toml --locked
cargo clippy --manifest-path src-tauri/Cargo.toml --locked -- -D warnings
npm run tauri build
```

CI runs these checks on macOS. Bundling and release distribution are not configured yet. See [the architecture draft](docs/architecture.md) for current boundaries and outstanding decisions.

With a local Ollama server running, verify the real connection separately:

```sh
cargo test --manifest-path src-tauri/Cargo.toml --locked connects_to_local_ollama -- --ignored
```

Read-only local-service integration checks:

```sh
cargo test --manifest-path src-tauri/Cargo.toml --locked -- --ignored
```

To manually verify model lifecycle controls, run `npm run tauri dev`, open an installed model's details, load it, refresh running status, then unload it and refresh again. Confirm the loaded state follows Ollama's `/api/ps` response. Loading uses Ollama's default keep-alive behavior and does not start or stop the Ollama service. These lifecycle actions change local model runtime state; perform this check only when it is safe to load and unload a model on the machine.
