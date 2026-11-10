import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

type Connection =
  | { state: "connecting" }
  | { state: "connected"; version: string }
  | { state: "unavailable" };

export default function App() {
  const [connection, setConnection] = useState<Connection>({
    state: "connecting",
  });
  const [attempt, setAttempt] = useState(0);

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
      </section>
      <footer>Development build</footer>
    </main>
  );
}
