import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

type Connection =
  | { state: "connecting" }
  | { state: "connected"; version: string }
  | { state: "unavailable" };
type Models =
  | { state: "loading" }
  | { state: "loaded"; names: string[] }
  | { state: "error" };

export default function App() {
  const [connection, setConnection] = useState<Connection>({
    state: "connecting",
  });
  const [attempt, setAttempt] = useState(0);
  const [models, setModels] = useState<Models>({ state: "loading" });
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let active = true;
    invoke<string>("ollama_connection").then(
      (version) => {
        if (active) setConnection({ state: "connected", version });
      },
      () => {
        if (active) setConnection({ state: "unavailable" });
      },
    );
    return () => {
      active = false;
    };
  }, [attempt]);

  useEffect(() => {
    if (connection.state !== "connected") return;
    let active = true;
    invoke<string[]>("ollama_models").then(
      (names) => {
        if (active) setModels({ state: "loaded", names });
      },
      () => {
        if (active) setModels({ state: "error" });
      },
    );
    return () => {
      active = false;
    };
  }, [connection, refresh]);

  function refreshModels() {
    setModels({ state: "loading" });
    setRefresh((n) => n + 1);
  }

  return (
    <main>
      <div className="wordmark">LOKVYN / DESKTOP</div>
      <section aria-labelledby="title">
        <p className="eyebrow">LOCAL MODELS</p>
        <h1 id="title">Lokvyn</h1>
        <div className="connection" role="status" aria-live="polite">
          {connection.state === "connecting" && <p>Connecting to Ollama...</p>}
          {connection.state === "connected" && (
            <>
              <p className="connected">Connected</p>
              <p>Version {connection.version}</p>
            </>
          )}
          {connection.state === "unavailable" && (
            <>
              <p className="unavailable">Ollama is unavailable</p>
              <p>Check that Ollama is running on this computer.</p>
            </>
          )}
        </div>
        {connection.state === "unavailable" && (
          <button
            type="button"
            onClick={() => {
              setConnection({ state: "connecting" });
              setAttempt((n) => n + 1);
            }}
          >
            Retry connection
          </button>
        )}
        {connection.state === "connected" && (
          <div className="models" aria-labelledby="models-title">
            <div className="models-heading">
              <h2 id="models-title">Installed models</h2>
              {models.state === "loaded" && (
                <button type="button" onClick={refreshModels}>
                  Refresh models
                </button>
              )}
            </div>
            <div role="status" aria-live="polite">
              {models.state === "loading" && <p>Loading models...</p>}
              {models.state === "error" && <p>Could not load models</p>}
              {models.state === "loaded" && models.names.length === 0 && (
                <p>No models installed</p>
              )}
            </div>
            {models.state === "error" && (
              <button type="button" onClick={refreshModels}>
                Retry models
              </button>
            )}
            {models.state === "loaded" && models.names.length > 0 && (
              <ul>
                {models.names.map((name, index) => (
                  <li key={`${name}-${index}`}>{name}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>
      <footer>Development build</footer>
    </main>
  );
}
