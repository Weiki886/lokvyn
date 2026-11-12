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
type RunningModel = {
  name: string;
  sizeVram: number | null;
  expiresAt: string | null;
};
type RunningModels =
  | { state: "loading" }
  | { state: "loaded"; models: RunningModel[] }
  | { state: "error" };
type ModelDetails = {
  format: string | null;
  family: string | null;
  parameter_size: string | null;
  quantization_level: string | null;
  parameters: string | null;
  template: string | null;
  system: string | null;
  model_info: Record<string, string>;
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

function hasModelConfiguration(details: ModelDetails) {
  return Boolean(
    details.parameters ||
    details.template ||
    details.system ||
    Object.keys(details.model_info ?? {}).length > 0,
  );
}

export default function App() {
  const [connection, setConnection] = useState<Connection>({
    state: "connecting",
  });
  const [attempt, setAttempt] = useState(0);
  const [models, setModels] = useState<Models>({ state: "loading" });
  const [refresh, setRefresh] = useState(0);
  const [runningModels, setRunningModels] = useState<RunningModels>({
    state: "loading",
  });
  const [runningRefresh, setRunningRefresh] = useState(0);
  const [modelAction, setModelAction] = useState<{
    name: string;
    action: "loading" | "unloading";
  } | null>(null);
  const [actionError, setActionError] = useState(false);
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
    if (connection.state !== "connected") return;
    let active = true;
    invoke<RunningModel[]>("ollama_running_models").then(
      (models) => {
        if (active) setRunningModels({ state: "loaded", models });
      },
      () => {
        if (active) setRunningModels({ state: "error" });
      },
    );
    return () => {
      active = false;
    };
  }, [connection, runningRefresh]);

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

  function refreshRunningModels() {
    setRunningModels({ state: "loading" });
    setActionError(false);
    setRunningRefresh((n) => n + 1);
  }

  async function changeModelState(name: string, loaded: boolean) {
    setModelAction({ name, action: loaded ? "loading" : "unloading" });
    setActionError(false);
    try {
      await invoke(loaded ? "ollama_load_model" : "ollama_unload_model", {
        modelName: name,
      });
    } catch {
      // The request outcome can be uncertain; the runtime query decides the state.
    }
    try {
      const currentModels = await invoke<RunningModel[]>(
        "ollama_running_models",
      );
      setRunningModels({ state: "loaded", models: currentModels });
      setActionError(
        currentModels.some((runningModel) => runningModel.name === name) !==
          loaded,
      );
    } catch {
      setRunningModels({ state: "error" });
      setActionError(true);
    } finally {
      setModelAction(null);
    }
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
              <div className="model-actions">
                {models.state === "loaded" && (
                  <button type="button" onClick={refreshModels}>
                    Refresh models
                  </button>
                )}
                {runningModels.state !== "loading" && (
                  <button
                    type="button"
                    disabled={modelAction !== null}
                    onClick={refreshRunningModels}
                  >
                    Refresh running status
                  </button>
                )}
              </div>
            </div>
            <div className="runtime-status" role="status" aria-live="polite">
              {runningModels.state === "loading" && (
                <p>Checking loaded models...</p>
              )}
              {runningModels.state === "error" && (
                <p className="unavailable">Could not check loaded models</p>
              )}
              {actionError && (
                <p className="unavailable">
                  Model state could not be confirmed. Refresh status before
                  retrying.
                </p>
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
                  const running =
                    runningModels.state === "loaded"
                      ? runningModels.models.find(
                          (runningModel) => runningModel.name === model.name,
                        )
                      : undefined;
                  const busy = modelAction?.name === model.name;
                  const actionDisabled =
                    runningModels.state !== "loaded" || modelAction !== null;
                  return (
                    <li key={model.name}>
                      <div className="model-row">
                        <button
                          className="model-select"
                          type="button"
                          aria-label={model.name}
                          onClick={() => openModel(model.name)}
                        >
                          <span className="model-name">{model.name}</span>
                          {(size || modifiedAt || running) && (
                            <span className="model-metadata">
                              {size && <span>{size}</span>}
                              {modifiedAt && <span>{modifiedAt}</span>}
                              {running && (
                                <span className="loaded-label">Loaded</span>
                              )}
                              {running?.sizeVram !== null &&
                                running?.sizeVram !== undefined && (
                                  <span>
                                    {formatSize(running.sizeVram)} VRAM
                                  </span>
                                )}
                            </span>
                          )}
                        </button>
                        <button
                          type="button"
                          disabled={actionDisabled}
                          aria-label={
                            busy
                              ? `${modelAction.action === "loading" ? "Loading" : "Unloading"} ${model.name}`
                              : `${running ? "Unload" : "Load"} ${model.name}`
                          }
                          onClick={() => changeModelState(model.name, !running)}
                        >
                          {busy
                            ? modelAction.action === "loading"
                              ? "Loading..."
                              : "Unloading..."
                            : running
                              ? "Unload"
                              : "Load"}
                        </button>
                      </div>
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
                ![
                  details.value.format,
                  details.value.family,
                  details.value.parameter_size,
                  details.value.quantization_level,
                  details.value.parameters,
                  details.value.template,
                  details.value.system,
                  Object.keys(details.value.model_info ?? {}).length > 0,
                ].some(Boolean) && <p>Model details unavailable</p>}
            </div>
            {details.state === "error" && (
              <button type="button" onClick={retryDetails}>
                Retry details
              </button>
            )}
            {details.state === "loaded" &&
              [
                details.value.format,
                details.value.family,
                details.value.parameter_size,
                details.value.quantization_level,
              ].some(Boolean) && (
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
            {details.state === "loaded" &&
              hasModelConfiguration(details.value) && (
                <div className="configuration-list">
                  {[
                    ["Model parameters", details.value.parameters],
                    ["Prompt template", details.value.template],
                    ["System prompt", details.value.system],
                  ].map(
                    ([label, value]) =>
                      value && (
                        <details key={label}>
                          <summary>{label}</summary>
                          <pre>{value}</pre>
                        </details>
                      ),
                  )}
                  {Object.keys(details.value.model_info ?? {}).length > 0 && (
                    <details>
                      <summary>Model information</summary>
                      <dl className="model-info-list">
                        {Object.entries(details.value.model_info ?? {}).map(
                          ([key, value]) => (
                            <div key={key}>
                              <dt>{key}</dt>
                              <dd>{value}</dd>
                            </div>
                          ),
                        )}
                      </dl>
                    </details>
                  )}
                </div>
              )}
          </div>
        )}
      </section>
      <footer>Development build</footer>
    </main>
  );
}
