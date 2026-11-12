import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import {
  Activity,
  Box,
  ChevronRight,
  Compass,
  Copy,
  Download,
  KeyRound,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Play,
  RefreshCw,
  Search,
  Server,
  Settings,
  Square,
  Trash2,
  X,
} from "lucide-react";
import WorkspaceViews, { type View } from "./WorkspaceViews";

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
  const [view, setView] = useState<View>("Installed models");
  const [search, setSearch] = useState("");
  const [collapsed, setCollapsed] = useState(false);
  const [chatModel, setChatModel] = useState("");
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

  const isModelView = view === "Installed models" || view === "Running models";
  const sourceModels =
    view === "Running models"
      ? runningModels.state === "loaded"
        ? runningModels.models.map((model) => ({
            name: model.name,
            size: null,
            modifiedAt: null,
          }))
        : []
      : models.state === "loaded"
        ? models.models
        : [];
  const visibleModels = sourceModels.filter((model) =>
    model.name.toLowerCase().includes(search.trim().toLowerCase()),
  );
  const navGroups = [
    {
      label: "MODELS",
      items: [
        { name: "Discover", icon: Compass },
        { name: "Installed models", icon: Box },
        { name: "Running models", icon: Activity },
        { name: "Downloads", icon: Download },
      ],
    },
    {
      label: "WORKSPACE",
      items: [
        { name: "Chat", icon: MessageSquare },
        { name: "API access", icon: KeyRound },
      ],
    },
    { label: "APPLICATION", items: [{ name: "Settings", icon: Settings }] },
  ] as const;

  return (
    <div className={`app-shell ${collapsed ? "sidebar-collapsed" : ""}`}>
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">
            <Box size={21} />
          </span>
          <strong>Lokvyn</strong>
          <span className="brand-tag">LOCAL AI</span>
        </div>
        <div className="topbar-context">
          <button
            className="icon-button"
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            onClick={() => setCollapsed(!collapsed)}
          >
            {collapsed ? (
              <PanelLeftOpen size={18} />
            ) : (
              <PanelLeftClose size={18} />
            )}
          </button>
          <span className="breadcrumb">
            Workspace <ChevronRight size={14} />
            <span>{view}</span>
          </span>
        </div>
        <button
          className="icon-button"
          aria-label="Open settings"
          title="Settings"
          onClick={() => setView("Settings")}
        >
          <Settings size={18} />
        </button>
      </header>
      <aside className="sidebar">
        <nav aria-label="Main navigation">
          {navGroups.map((group) => (
            <div className="nav-group" key={group.label}>
              <p className="nav-label">{group.label}</p>
              {group.items.map(({ name, icon: Icon }) => (
                <button
                  key={name}
                  aria-label={`Navigate to ${name}`}
                  aria-current={view === name ? "page" : undefined}
                  title={name}
                  className={`nav-item ${view === name ? "active" : ""}`}
                  onClick={() => {
                    setView(name);
                    setSearch("");
                  }}
                >
                  <Icon size={18} />
                  <span>{name}</span>
                  {name === "Installed models" && models.state === "loaded" && (
                    <small>{models.models.length}</small>
                  )}
                  {name === "Running models" &&
                    runningModels.state === "loaded" && (
                      <small>{runningModels.models.length}</small>
                    )}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-service">
          <Server size={18} />
          <div>
            <strong>Local Ollama</strong>
            <span>127.0.0.1:11434</span>
          </div>
          <i
            className={`status-dot ${connection.state === "connected" ? "online" : ""}`}
          />
        </div>
      </aside>
      <main className="main-workspace">
        <div className="workspace-heading">
          <div>
            <span className="eyebrow">
              {isModelView ? "MODEL WORKSPACE" : "LOCAL WORKSPACE"}
            </span>
            <h1 id="title">{view}</h1>
          </div>
          {isModelView && (
            <button className="primary" onClick={() => setView("Discover")}>
              <Compass size={16} />
              Browse models
            </button>
          )}
        </div>
        <div
          className={`workspace-body ${isModelView ? "with-inspector" : ""}`}
        >
          <section className="workspace-content" aria-labelledby="title">
            <div
              className="connection connection-banner"
              role="status"
              aria-live="polite"
            >
              {connection.state === "connecting" && (
                <p>Connecting to Ollama...</p>
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
            {isModelView && connection.state === "connected" && (
              <div className="models" aria-labelledby="models-title">
                <div className="models-heading">
                  <label className="search-field">
                    <Search size={16} />
                    <input
                      type="search"
                      aria-label={`Search ${view.toLowerCase()}`}
                      placeholder="Search models..."
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                    />
                  </label>
                  <div className="model-actions">
                    {models.state === "loaded" && (
                      <button
                        className="icon-button"
                        aria-label="Refresh models"
                        title="Refresh models"
                        type="button"
                        onClick={refreshModels}
                      >
                        <RefreshCw size={17} />
                      </button>
                    )}
                    {runningModels.state !== "loading" && (
                      <button
                        type="button"
                        className="icon-button"
                        aria-label="Refresh running status"
                        title="Refresh running status"
                        disabled={modelAction !== null}
                        onClick={refreshRunningModels}
                      >
                        <Activity size={17} />
                      </button>
                    )}
                  </div>
                </div>
                <div className="table-caption">
                  <h2 id="models-title">
                    {view === "Running models"
                      ? "In memory"
                      : "On this computer"}
                  </h2>
                  <span>{sourceModels.length} models</span>
                </div>
                <div
                  className="runtime-status"
                  role="status"
                  aria-live="polite"
                >
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
                  {view === "Installed models" &&
                    models.state === "loading" && <p>Loading models...</p>}
                  {view === "Installed models" && models.state === "error" && (
                    <p>Could not load models</p>
                  )}
                  {view === "Installed models" &&
                    models.state === "loaded" &&
                    models.models.length === 0 && (
                      <div className="empty-state">
                        <Box size={40} strokeWidth={1.4} />
                        <h3>No models installed</h3>
                        <p>Your downloaded models will appear here.</p>
                        <button onClick={() => setView("Discover")}>
                          <Compass size={16} />
                          Explore models
                        </button>
                      </div>
                    )}
                  {view === "Running models" &&
                    runningModels.state === "loaded" &&
                    sourceModels.length === 0 && (
                      <div className="empty-state">
                        <Activity size={40} strokeWidth={1.4} />
                        <h3>No models running</h3>
                        <p>Load a model from Installed models.</p>
                      </div>
                    )}
                  {sourceModels.length > 0 && visibleModels.length === 0 && (
                    <div className="empty-state">
                      <Search size={30} />
                      <h3>No matching models</h3>
                      <p>Try another model name.</p>
                    </div>
                  )}
                </div>
                {view === "Installed models" && models.state === "error" && (
                  <button type="button" onClick={refreshModels}>
                    Retry models
                  </button>
                )}
                {visibleModels.length > 0 && (
                  <>
                    <div className="table-header" aria-hidden="true">
                      <span>MODEL NAME</span>
                      <span>SIZE / UPDATED</span>
                      <span>RUNTIME</span>
                    </div>
                    <ul className="model-list">
                      {visibleModels.map((model) => {
                        const size = formatSize(model.size);
                        const modifiedAt = formatModifiedAt(model.modifiedAt);
                        const running =
                          runningModels.state === "loaded"
                            ? runningModels.models.find(
                                (runningModel) =>
                                  runningModel.name === model.name,
                              )
                            : undefined;
                        const busy = modelAction?.name === model.name;
                        const actionDisabled =
                          runningModels.state !== "loaded" ||
                          modelAction !== null;
                        return (
                          <li
                            key={model.name}
                            className={
                              selectedModel === model.name ? "selected" : ""
                            }
                          >
                            <div className="model-row">
                              <button
                                className="model-select"
                                type="button"
                                aria-label={model.name}
                                aria-pressed={selectedModel === model.name}
                                onClick={() => openModel(model.name)}
                              >
                                <span className="model-name">
                                  <Box size={18} />
                                  {model.name}
                                </span>
                                {(size || modifiedAt || running) && (
                                  <span className="model-metadata">
                                    {size && <span>{size}</span>}
                                    {modifiedAt && <span>{modifiedAt}</span>}
                                    {running && (
                                      <span className="loaded-label">
                                        Loaded
                                      </span>
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
                                className="runtime-button"
                                type="button"
                                disabled={actionDisabled}
                                aria-label={
                                  busy
                                    ? `${modelAction.action === "loading" ? "Loading" : "Unloading"} ${model.name}`
                                    : `${running ? "Unload" : "Load"} ${model.name}`
                                }
                                onClick={() =>
                                  changeModelState(model.name, !running)
                                }
                              >
                                {running ? (
                                  <Square size={13} />
                                ) : (
                                  <Play size={13} />
                                )}
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
                  </>
                )}
              </div>
            )}
            {!isModelView && (
              <WorkspaceViews
                view={view}
                models={
                  models.state === "loaded"
                    ? models.models.map((model) => model.name)
                    : []
                }
                chatModel={chatModel}
                setChatModel={setChatModel}
                connected={connection.state === "connected"}
              />
            )}
          </section>
          {isModelView && (
            <aside className="inspector" aria-label="Model inspector">
              <div className="inspector-caption">
                <span>MODEL INSPECTOR</span>
                {selectedModel && (
                  <button
                    type="button"
                    className="icon-button"
                    aria-label="Back to models"
                    title="Close inspector"
                    onClick={() => setSelectedModel(null)}
                  >
                    <X size={16} />
                  </button>
                )}
              </div>
              {!selectedModel && (
                <div className="empty-state inspector-empty">
                  <Box size={38} strokeWidth={1.3} />
                  <h3>Select a model</h3>
                  <p>Details, configuration and model actions.</p>
                </div>
              )}
              {connection.state === "connected" && selectedModel !== null && (
                <div className="model-details" aria-labelledby="details-title">
                  <div className="inspector-model-icon">
                    <Box size={26} />
                  </div>
                  <span className="eyebrow">LOCAL MODEL</span>
                  <div className="models-heading">
                    <h2 id="details-title">{selectedModel}</h2>
                  </div>
                  <button
                    className="chat-model-button"
                    onClick={() => {
                      setChatModel(selectedModel);
                      setView("Chat");
                    }}
                  >
                    <MessageSquare size={16} />
                    Open in Chat
                    <ChevronRight size={14} />
                  </button>
                  <div role="status" aria-live="polite">
                    {details.state === "loading" && (
                      <p>Loading model details...</p>
                    )}
                    {details.state === "error" && (
                      <p>Could not load model details</p>
                    )}
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
                        {Object.keys(details.value.model_info ?? {}).length >
                          0 && (
                          <details>
                            <summary>Model information</summary>
                            <dl className="model-info-list">
                              {Object.entries(
                                details.value.model_info ?? {},
                              ).map(([key, value]) => (
                                <div key={key}>
                                  <dt>{key}</dt>
                                  <dd>{value}</dd>
                                </div>
                              ))}
                            </dl>
                          </details>
                        )}
                      </div>
                    )}
                  <div className="model-management">
                    <div className="section-heading">
                      <h3>Manage model</h3>
                      <span className="preview-label">Pending</span>
                    </div>
                    <button disabled aria-label="Rename model">
                      <Pencil size={15} />
                      Rename
                    </button>
                    <button disabled aria-label="Duplicate model">
                      <Copy size={15} />
                      Duplicate
                    </button>
                    <button
                      disabled
                      aria-label="Delete model"
                      className="danger"
                    >
                      <Trash2 size={15} />
                      Delete model
                    </button>
                    <span className="quiet-note">
                      Model management is not connected yet.
                    </span>
                  </div>
                </div>
              )}
            </aside>
          )}
        </div>
      </main>
      <footer className="statusbar">
        <span className="footer-brand">
          <Box size={13} />
          Lokvyn <span>0.1.0</span>
        </span>
        <span className="connection" role="status">
          <i
            className={`status-dot ${connection.state === "connected" ? "online" : ""}`}
          />
          {connection.state === "connected" ? (
            <>
              <span>Connected</span>
              <span className="version">Version {connection.version}</span>
            </>
          ) : connection.state === "connecting" ? (
            "Connecting"
          ) : (
            "Disconnected"
          )}
        </span>
        <span className="footer-end">
          <Server size={13} />
          Local Ollama
          <span className="development-label">Development build</span>
        </span>
      </footer>
    </div>
  );
}
