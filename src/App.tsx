import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

type Connection =
  | { state: "connecting" }
  | { state: "connected"; version: string }
  | { state: "unavailable" };
type Models =
  | { state: "loading" }
  | { state: "loaded"; models: OllamaModel[] }
  | { state: "error" };
type OllamaModel = {
  name: string;
  size: number | null;
  modifiedAt: string | null;
};
type ModelDetails = {
  format: string | null;
  family: string | null;
  parameter_size: string | null;
  quantization_level: string | null;
};
type Details =
  | { state: "loading" }
  | { state: "loaded"; value: ModelDetails }
  | { state: "error" };

function formatSize(size: number | null) {
  if (size === null || !Number.isFinite(size) || size < 0) return null;
  if (size < 1024) return `${size} bytes`;
  const units = ["KiB", "MiB", "GiB", "TiB", "PiB"];
  let value = size;
  let unit = -1;
  do {
    value /= 1024;
    unit += 1;
  } while (value >= 1024 && unit < units.length - 1);
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value)} ${units[unit]}`;
}

function formatModifiedAt(value: string | null) {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export default function App() {
  const [connection, setConnection] = useState<Connection>({
    state: "connecting",
  });
  const [attempt, setAttempt] = useState(0);
  const [models, setModels] = useState<Models>({ state: "loading" });
  const [refresh, setRefresh] = useState(0);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [details, setDetails] = useState<Details>({ state: "loading" });
  const [detailsAttempt, setDetailsAttempt] = useState(0);

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
    invoke<OllamaModel[]>("ollama_models").then(
      (models) => {
        if (active) setModels({ state: "loaded", models });
      },
      () => {
        if (active) setModels({ state: "error" });
      },
    );
    return () => {
      active = false;
    };
  }, [connection, refresh]);

  useEffect(() => {
    if (!selectedModel) return;
    let active = true;
    invoke<ModelDetails>("ollama_model_details", {
      modelName: selectedModel,
    }).then(
      (value) => {
        if (active) setDetails({ state: "loaded", value });
      },
      () => {
        if (active) setDetails({ state: "error" });
      },
    );
    return () => {
      active = false;
    };
  }, [selectedModel, detailsAttempt]);

  function refreshModels() {
    setModels({ state: "loading" });
    setRefresh((n) => n + 1);
  }

  function openModel(name: string) {
    setDetails({ state: "loading" });
    setSelectedModel(name);
    setDetailsAttempt((attempt) => attempt + 1);
  }

  function retryDetails() {
    setDetails({ state: "loading" });
    setDetailsAttempt((attempt) => attempt + 1);
  }

  return (
    <main>
      <div className="wordmark">LOKVYN / DESKTOP</div>
      <section aria-labelledby="title">
        <p className="eyebrow">LOCAL MODELS</p>
        <h1 id="title">Lokvyn</h1>
        <div className="connection" role="status" aria-live="polite">
          {connection.state === "connecting" && <p>Connecting to Ollama...</p>}
          {connection.state === "connected" && selectedModel === null && (
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
              {models.state === "loaded" && models.models.length === 0 && (
                <p>No models installed</p>
              )}
            </div>
            {models.state === "error" && (
              <button type="button" onClick={refreshModels}>
                Retry models
              </button>
            )}
            {models.state === "loaded" && models.models.length > 0 && (
              <ul>
                {models.models.map((model) => {
                  const size = formatSize(model.size);
                  const modifiedAt = formatModifiedAt(model.modifiedAt);
                  return (
                    <li key={model.name}>
                      <button
                        type="button"
                        aria-label={model.name}
                        onClick={() => openModel(model.name)}
                      >
                        <span className="model-name">{model.name}</span>
                        {(size || modifiedAt) && (
                          <span className="model-metadata">
                            {size && <span>{size}</span>}
                            {modifiedAt && <span>{modifiedAt}</span>}
                          </span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
        {connection.state === "connected" && selectedModel !== null && (
          <div className="model-details" aria-labelledby="details-title">
            <div className="models-heading">
              <h2 id="details-title">{selectedModel}</h2>
              <button type="button" onClick={() => setSelectedModel(null)}>
                Back to models
              </button>
            </div>
            <div role="status" aria-live="polite">
              {details.state === "loading" && <p>Loading model details...</p>}
              {details.state === "error" && <p>Could not load model details</p>}
              {details.state === "loaded" &&
                !Object.values(details.value).some(Boolean) && (
                  <p>Model details unavailable</p>
                )}
            </div>
            {details.state === "error" && (
              <button type="button" onClick={retryDetails}>
                Retry details
              </button>
            )}
            {details.state === "loaded" &&
              Object.values(details.value).some(Boolean) && (
                <dl className="detail-list">
                  {[
                    ["Format", details.value.format],
                    ["Family", details.value.family],
                    ["Parameters", details.value.parameter_size],
                    ["Quantization", details.value.quantization_level],
                  ].map(
                    ([label, value]) =>
                      value && (
                        <div key={label}>
                          <dt>{label}</dt>
                          <dd>{value}</dd>
                        </div>
                      ),
                  )}
                </dl>
              )}
          </div>
        )}
      </section>
      <footer>Development build</footer>
    </main>
  );
}
