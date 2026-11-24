import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
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
import WorkspaceViews, { type CatalogModel, type View } from "./WorkspaceViews";
import {
  readCatalogPages,
  readModelDetails,
  writeCatalogPage,
  writeModelDetails,
} from "./catalogCache";
import { TextInput } from "./FormControls";
import { readLocale, saveLocale, translate, type Locale } from "./i18n";

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
type Catalog = {
  state: "idle" | "loading" | "loaded" | "error";
  models: CatalogModel[];
  page: number;
  hasMore: boolean;
  loadingMore: boolean;
  loadMoreError: boolean;
};
type CatalogModelDetails = Pick<CatalogModel, "variants" | "downloadSize">;
type CatalogModelDetailState =
  | { state: "loading" }
  | { state: "loaded"; value: CatalogModelDetails }
  | { state: "error" };
type CachedCatalog = { value: Catalog; savedAt: number };
type CachedCatalogDetails = { value: CatalogModelDetails; savedAt: number };
type DownloadTask = {
  model: string;
  state: "queued" | "downloading" | "paused" | "completed" | "error";
  message: string;
  completed: number | null;
  total: number | null;
};
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

function formatSize(size: number | null, locale: Locale) {
  if (size === null || !Number.isFinite(size) || size < 0) return null;
  if (size < 1024) return `${size} ${translate(locale, "bytes")}`;
  const units = ["KiB", "MiB", "GiB", "TiB", "PiB"];
  let value = size;
  let unit = -1;
  do {
    value /= 1024;
    unit += 1;
  } while (value >= 1024 && unit < units.length - 1);
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value)} ${units[unit]}`;
}

function formatModifiedAt(value: string | null, locale: Locale) {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat(locale, {
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
  const [locale, setLocale] = useState<Locale>(readLocale);
  const [appVersion, setAppVersion] = useState("");
  const t = (source: string) => translate(locale, source);
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
  const [catalogQuery, setCatalogQuery] = useState("");
  const [catalogSort, setCatalogSort] = useState("popular");
  const [catalogCapability, setCatalogCapability] = useState("");
  const [catalogAttempt, setCatalogAttempt] = useState(0);
  const [catalog, setCatalog] = useState<Catalog>({
    state: "idle",
    models: [],
    page: 0,
    hasMore: false,
    loadingMore: false,
    loadMoreError: false,
  });
  const [catalogUpdatedAt, setCatalogUpdatedAt] = useState<number | null>(null);
  const [catalogRefreshError, setCatalogRefreshError] = useState<string | null>(
    null,
  );
  const [catalogModelDetails, setCatalogModelDetails] = useState<
    Record<string, CatalogModelDetailState>
  >({});
  const [downloads, setDownloads] = useState<DownloadTask[]>([]);
  const catalogRequestId = useRef(0);
  const forceCatalogRefresh = useRef(false);
  const catalogCache = useRef(new Map<string, CachedCatalog>());
  const catalogDetailsCache = useRef(new Map<string, CachedCatalogDetails>());
  const catalogDetailRequests = useRef(new Map<string, Promise<void>>());
  const downloadActions = useRef(new Map<string, "pause" | "cancel">());

  useEffect(() => {
    saveLocale(locale);
    document.documentElement.lang = locale;
  }, [locale]);

  useEffect(() => {
    let active = true;
    getVersion().then(
      (version) => {
        if (active) setAppVersion(version);
      },
      () => {
        if (active) setAppVersion("");
      },
    );
    return () => {
      active = false;
    };
  }, []);

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

  useEffect(() => {
    if (view !== "Discover") return;
    let active = true;
    const requestId = ++catalogRequestId.current;
    const key = JSON.stringify([
      catalogQuery.trim(),
      catalogSort,
      catalogCapability,
    ]);
    const forceRefresh = forceCatalogRefresh.current;
    forceCatalogRefresh.current = false;
    const cached = catalogCache.current.get(key);
    if (cached) {
      setCatalogUpdatedAt(cached.savedAt);
      setCatalog({
        ...cached.value,
        state: "loaded",
        loadingMore:
          forceRefresh || Date.now() - cached.savedAt >= 5 * 60 * 1000,
        loadMoreError: false,
      });
    } else {
      setCatalogUpdatedAt(null);
      setCatalog({
        state: "loading",
        models: [],
        page: 0,
        hasMore: false,
        loadingMore: false,
        loadMoreError: false,
      });
    }
    if (
      cached &&
      Date.now() - cached.savedAt < 5 * 60 * 1000 &&
      !forceRefresh
    ) {
      return () => {
        active = false;
      };
    }
    const timer = window.setTimeout(
      () => {
        void (async () => {
          let restored = cached;
          if (!restored) {
            try {
              const pages = await readCatalogPages(key);
              if (!active || catalogRequestId.current !== requestId) return;
              if (pages[0]?.page === 1) {
                const contiguousPages: typeof pages = [];
                for (const page of pages) {
                  if (page.page !== contiguousPages.length + 1) break;
                  contiguousPages.push(page);
                  if (!page.hasMore) break;
                }
                const models = contiguousPages.flatMap((page) => page.models);
                const latest = contiguousPages[contiguousPages.length - 1];
                if (!latest) return;
                const value: Catalog = {
                  state: "loaded",
                  models,
                  page: latest.page,
                  hasMore: latest.hasMore,
                  loadingMore:
                    forceRefresh ||
                    Date.now() - contiguousPages[0].savedAt >= 5 * 60 * 1000,
                  loadMoreError: false,
                };
                restored = {
                  value,
                  savedAt: contiguousPages[0].savedAt,
                };
                catalogCache.current.set(key, restored);
                if (catalogCache.current.size > 12) {
                  const oldestKey = catalogCache.current.keys().next().value;
                  if (oldestKey) catalogCache.current.delete(oldestKey);
                }
                setCatalogUpdatedAt(restored.savedAt);
                setCatalog(value);
              }
            } catch {
              // IndexedDB is optional; continue with the live catalog request.
            }
          }
          if (
            restored &&
            Date.now() - restored.savedAt < 5 * 60 * 1000 &&
            !forceRefresh
          )
            return;
          try {
            const result = await invoke<{
              models: CatalogModel[];
              page: number;
              hasMore: boolean;
            }>("ollama_catalog", {
              query: catalogQuery,
              page: 1,
              sort: catalogSort,
              capability: catalogCapability,
            });
            if (!active || catalogRequestId.current !== requestId) return;
            const next: Catalog = {
              state: "loaded",
              models: result.models,
              page: result.page,
              hasMore: result.hasMore,
              loadingMore: false,
              loadMoreError: false,
            };
            const savedAt = Date.now();
            catalogCache.current.set(key, { value: next, savedAt });
            setCatalogUpdatedAt(savedAt);
            if (catalogCache.current.size > 12) {
              const oldestKey = catalogCache.current.keys().next().value;
              if (oldestKey) catalogCache.current.delete(oldestKey);
            }
            setCatalog(next);
            setCatalogRefreshError(null);
            void writeCatalogPage(key, {
              page: result.page,
              models: result.models,
              hasMore: result.hasMore,
              savedAt,
            });
          } catch {
            if (active && catalogRequestId.current === requestId) {
              setCatalog((current) =>
                restored
                  ? { ...current, state: "loaded", loadingMore: false }
                  : { ...current, state: "error" },
              );
              setCatalogRefreshError(restored ? key : null);
            }
          }
        })();
      },
      catalogQuery.trim() ? 250 : 0,
    );
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [view, catalogQuery, catalogSort, catalogCapability, catalogAttempt]);

  async function loadCatalogModelDetails(modelName: string, retry = false) {
    let cached = catalogDetailsCache.current.get(modelName);
    if (!retry && cached && Date.now() - cached.savedAt < 30 * 60 * 1000) {
      const value = cached.value;
      setCatalogModelDetails((current) => ({
        ...current,
        [modelName]: { state: "loaded", value },
      }));
      return;
    }
    const pending = catalogDetailRequests.current.get(modelName);
    if (pending) return pending;
    setCatalogModelDetails((current) => ({
      ...current,
      [modelName]: cached
        ? { state: "loaded", value: cached.value }
        : { state: "loading" },
    }));
    const request = (async () => {
      if (!cached && !retry) {
        try {
          const persisted = await readModelDetails(modelName);
          if (persisted) {
            cached = persisted;
            catalogDetailsCache.current.set(modelName, persisted);
            setCatalogModelDetails((current) => ({
              ...current,
              [modelName]: { state: "loaded", value: persisted.value },
            }));
            if (Date.now() - persisted.savedAt < 30 * 60 * 1000) return;
          }
        } catch {
          // IndexedDB is optional; continue with the live tags request.
        }
      }
      if (cached && Date.now() - cached.savedAt < 30 * 60 * 1000 && !retry)
        return;
      try {
        const value = await invoke<CatalogModelDetails>(
          "ollama_catalog_model",
          {
            modelName,
          },
        );
        const savedAt = Date.now();
        catalogDetailsCache.current.set(modelName, { value, savedAt });
        void writeModelDetails(modelName, value);
        if (catalogDetailsCache.current.size > 100) {
          const oldestModel = catalogDetailsCache.current.keys().next().value;
          if (oldestModel) catalogDetailsCache.current.delete(oldestModel);
        }
        setCatalogModelDetails((current) => ({
          ...current,
          [modelName]: { state: "loaded", value },
        }));
      } catch {
        setCatalogModelDetails((current) => ({
          ...current,
          [modelName]: cached
            ? { state: "loaded", value: cached.value }
            : { state: "error" },
        }));
      }
    })().finally(() => catalogDetailRequests.current.delete(modelName));
    catalogDetailRequests.current.set(modelName, request);
    return request;
  }

  function retryCatalog() {
    setCatalogRefreshError(null);
    forceCatalogRefresh.current = true;
    setCatalogAttempt((attempt) => attempt + 1);
  }

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void listen<{
      model: string;
      status: "downloading" | "complete";
      message: string;
      completed: number | null;
      total: number | null;
    }>("ollama-pull-progress", (event) => {
      const progress = event.payload;
      setDownloads((current) =>
        current.map((task) =>
          task.model === progress.model
            ? {
                ...task,
                state:
                  progress.status === "complete" ? "completed" : "downloading",
                message: progress.message,
                completed: progress.completed,
                total: progress.total,
              }
            : task,
        ),
      );
    }).then((stop) => {
      if (cancelled) stop();
      else unlisten = stop;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  function refreshModels() {
    setModels({ state: "loading" });
    setRefresh((n) => n + 1);
  }

  function refreshRunningModels() {
    setRunningModels({ state: "loading" });
    setActionError(false);
    setRunningRefresh((n) => n + 1);
  }

  async function loadMoreCatalog() {
    if (catalog.state !== "loaded" || !catalog.hasMore || catalog.loadingMore)
      return;
    const nextPage = catalog.page + 1;
    const requestId = catalogRequestId.current;
    setCatalog((current) => ({
      ...current,
      loadingMore: true,
      loadMoreError: false,
    }));
    try {
      const result = await invoke<{
        models: CatalogModel[];
        page: number;
        hasMore: boolean;
      }>("ollama_catalog", {
        query: catalogQuery,
        page: nextPage,
        sort: catalogSort,
        capability: catalogCapability,
      });
      if (requestId !== catalogRequestId.current) return;
      setCatalog((current) => {
        const next: Catalog = {
          ...current,
          models: [
            ...current.models,
            ...result.models.filter(
              (model) =>
                !current.models.some((loaded) => loaded.name === model.name),
            ),
          ],
          page: result.page,
          hasMore: result.hasMore,
          loadingMore: false,
        };
        const savedAt =
          catalogCache.current.get(
            JSON.stringify([
              catalogQuery.trim(),
              catalogSort,
              catalogCapability,
            ]),
          )?.savedAt ?? Date.now();
        catalogCache.current.set(
          JSON.stringify([catalogQuery.trim(), catalogSort, catalogCapability]),
          { value: next, savedAt },
        );
        setCatalogUpdatedAt(savedAt);
        if (catalogCache.current.size > 12) {
          const oldestKey = catalogCache.current.keys().next().value;
          if (oldestKey) catalogCache.current.delete(oldestKey);
        }
        void writeCatalogPage(
          JSON.stringify([catalogQuery.trim(), catalogSort, catalogCapability]),
          {
            page: result.page,
            models: result.models,
            hasMore: result.hasMore,
            savedAt,
          },
        );
        return next;
      });
    } catch {
      if (requestId !== catalogRequestId.current) return;
      setCatalog((current) => ({
        ...current,
        loadingMore: false,
        loadMoreError: true,
      }));
    }
  }

  async function downloadModel(model: string) {
    if (
      downloads.some(
        (task) =>
          task.model === model &&
          (task.state === "queued" || task.state === "downloading"),
      )
    )
      return;
    const queued = downloads.some(
      (task) => task.state === "queued" || task.state === "downloading",
    );
    setDownloads((current) => [
      {
        model,
        state: queued ? "queued" : "downloading",
        message: t(queued ? "Download queued" : "Starting download"),
        completed: null,
        total: null,
      },
      ...current.filter((task) => task.model !== model),
    ]);
    try {
      await invoke("ollama_pull_model", { modelName: model });
      setDownloads((current) =>
        current.map((task) =>
          task.model === model
            ? { ...task, state: "completed", message: t("Download complete") }
            : task,
        ),
      );
      refreshModels();
    } catch (error) {
      const action = downloadActions.current.get(model);
      downloadActions.current.delete(model);
      if (action === "cancel") {
        setDownloads((current) =>
          current.filter((task) => task.model !== model),
        );
        return;
      }
      const detail =
        typeof error === "string"
          ? error
          : error instanceof Error
            ? error.message
            : "";
      setDownloads((current) =>
        current.map((task) =>
          task.model === model
            ? {
                ...task,
                state: action === "pause" ? "paused" : "error",
                message:
                  action === "pause"
                    ? t("Download paused")
                    : detail
                      ? `${t("Download failed")}: ${detail.slice(0, 512)}`
                      : t("Download failed"),
              }
            : task,
        ),
      );
    }
  }

  async function pauseDownload(model: string) {
    downloadActions.current.set(model, "pause");
    try {
      await invoke("ollama_cancel_pull", { modelName: model });
    } catch {
      downloadActions.current.delete(model);
    }
  }

  async function cancelDownload(model: string) {
    downloadActions.current.set(model, "cancel");
    try {
      await invoke("ollama_cancel_pull", { modelName: model });
      setDownloads((current) => current.filter((task) => task.model !== model));
    } catch {
      downloadActions.current.delete(model);
    }
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
          <strong>Lokvyn</strong>
          <span className="brand-tag">{t("LOCAL AI")}</span>
        </div>
        <div className="topbar-context">
          <button
            className="icon-button"
            aria-label={t(collapsed ? "Expand sidebar" : "Collapse sidebar")}
            title={t(collapsed ? "Expand sidebar" : "Collapse sidebar")}
            onClick={() => setCollapsed(!collapsed)}
          >
            {collapsed ? (
              <PanelLeftOpen size={18} />
            ) : (
              <PanelLeftClose size={18} />
            )}
          </button>
          <span className="breadcrumb">
            {t("Workspace")} <ChevronRight size={14} />
            <span>{t(view)}</span>
          </span>
        </div>
        <button
          className="icon-button"
          aria-label={t("Open settings")}
          title={t("Settings")}
          onClick={() => setView("Settings")}
        >
          <Settings size={18} />
        </button>
      </header>
      <aside className="sidebar">
        <nav aria-label={t("Main navigation")}>
          {navGroups.map((group) => (
            <div className="nav-group" key={group.label}>
              <p className="nav-label">{t(group.label)}</p>
              {group.items.map(({ name, icon: Icon }) => (
                <button
                  key={name}
                  aria-label={t("Navigate to {view}").replace(
                    "{view}",
                    t(name),
                  )}
                  aria-current={view === name ? "page" : undefined}
                  title={t(name)}
                  className={`nav-item ${view === name ? "active" : ""}`}
                  onClick={() => {
                    setView(name);
                    setSearch("");
                  }}
                >
                  <Icon size={18} />
                  <span>{t(name)}</span>
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
        <section className="sidebar-service" aria-label={t("Local Ollama")}>
          <div className="service-heading">
            <Server size={17} />
            <strong>{t("Local Ollama")}</strong>
            <i
              className={`status-dot ${connection.state === "connected" ? "online" : ""}`}
            />
          </div>
          <div className="service-summary">
            <code>127.0.0.1:11434</code>
            <p>
              {t(
                connection.state === "connected"
                  ? "Service available"
                  : connection.state === "connecting"
                    ? "Connecting"
                    : "Unavailable",
              )}
            </p>
            <dl>
              <div>
                <dt>{t("Installed models")}</dt>
                <dd aria-label={t("Installed models")}>
                  {connection.state === "connected" && models.state === "loaded"
                    ? models.models.length
                    : t(
                        connection.state === "unavailable" ||
                          models.state === "error"
                          ? "Unavailable"
                          : "Loading",
                      )}
                </dd>
              </div>
              <div>
                <dt>{t("Running models")}</dt>
                <dd aria-label={t("Running models")}>
                  {connection.state === "connected" &&
                  runningModels.state === "loaded"
                    ? runningModels.models.length
                    : t(
                        connection.state === "unavailable" ||
                          runningModels.state === "error"
                          ? "Unavailable"
                          : "Loading",
                      )}
                </dd>
              </div>
            </dl>
          </div>
        </section>
      </aside>
      <main className="main-workspace">
        <div className="workspace-heading">
          <div>
            <span className="eyebrow">
              {t(isModelView ? "MODEL WORKSPACE" : "LOCAL WORKSPACE")}
            </span>
            <h1 id="title">{t(view)}</h1>
          </div>
          {isModelView && (
            <button className="primary" onClick={() => setView("Discover")}>
              <Compass size={16} />
              {t("Browse models")}
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
                <p>{t("Connecting to Ollama...")}</p>
              )}
              {connection.state === "unavailable" && (
                <>
                  <p className="unavailable">{t("Ollama is unavailable")}</p>
                  <p>{t("Check that Ollama is running on this computer.")}</p>
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
                {t("Retry connection")}
              </button>
            )}
            {isModelView && connection.state === "connected" && (
              <div className="models" aria-labelledby="models-title">
                <div className="models-heading">
                  <label className="search-field">
                    <Search size={16} />
                    <TextInput
                      type="search"
                      aria-label={t(`Search ${view.toLowerCase()}`)}
                      placeholder={t("Search models...")}
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                    />
                  </label>
                  <div className="model-actions">
                    {models.state === "loaded" && (
                      <button
                        className="icon-button"
                        aria-label={t("Refresh models")}
                        title={t("Refresh models")}
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
                        aria-label={t("Refresh running status")}
                        title={t("Refresh running status")}
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
                      ? t("In memory")
                      : t("On this computer")}
                  </h2>
                  <span>
                    {sourceModels.length} {t("models")}
                  </span>
                </div>
                <div
                  className="runtime-status"
                  role="status"
                  aria-live="polite"
                >
                  {runningModels.state === "loading" && (
                    <p>{t("Checking loaded models...")}</p>
                  )}
                  {runningModels.state === "error" && (
                    <p className="unavailable">
                      {t("Could not check loaded models")}
                    </p>
                  )}
                  {actionError && (
                    <p className="unavailable">
                      {t(
                        "Model state could not be confirmed. Refresh status before retrying.",
                      )}
                    </p>
                  )}
                </div>
                <div role="status" aria-live="polite">
                  {view === "Installed models" &&
                    models.state === "loading" && (
                      <p>{t("Loading models...")}</p>
                    )}
                  {view === "Installed models" && models.state === "error" && (
                    <p>{t("Could not load models")}</p>
                  )}
                  {view === "Installed models" &&
                    models.state === "loaded" &&
                    models.models.length === 0 && (
                      <div className="empty-state">
                        <Box size={40} strokeWidth={1.4} />
                        <h3>{t("No models installed")}</h3>
                        <p>{t("Your downloaded models will appear here.")}</p>
                        <button onClick={() => setView("Discover")}>
                          <Compass size={16} />
                          {t("Explore models")}
                        </button>
                      </div>
                    )}
                  {view === "Running models" &&
                    runningModels.state === "loaded" &&
                    sourceModels.length === 0 && (
                      <div className="empty-state">
                        <Activity size={40} strokeWidth={1.4} />
                        <h3>{t("No models running")}</h3>
                        <p>{t("Load a model from Installed models.")}</p>
                      </div>
                    )}
                  {sourceModels.length > 0 && visibleModels.length === 0 && (
                    <div className="empty-state">
                      <Search size={30} />
                      <h3>{t("No matching models")}</h3>
                      <p>{t("Try another model name.")}</p>
                    </div>
                  )}
                </div>
                {view === "Installed models" && models.state === "error" && (
                  <button type="button" onClick={refreshModels}>
                    {t("Retry models")}
                  </button>
                )}
                {visibleModels.length > 0 && (
                  <>
                    <div className="table-header" aria-hidden="true">
                      <span>{t("Model name")}</span>
                      <span>{t("Size / Updated")}</span>
                      <span>{t("Runtime")}</span>
                    </div>
                    <ul className="model-list">
                      {visibleModels.map((model) => {
                        const size = formatSize(model.size, locale);
                        const modifiedAt = formatModifiedAt(
                          model.modifiedAt,
                          locale,
                        );
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
                                        {t("Loaded")}
                                      </span>
                                    )}
                                    {running?.sizeVram !== null &&
                                      running?.sizeVram !== undefined && (
                                        <span>
                                          {formatSize(running.sizeVram, locale)}{" "}
                                          VRAM
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
                                    ? `${t(modelAction.action === "loading" ? "Loading" : "Unloading")} ${model.name}`
                                    : `${t(running ? "Unload" : "Load")} ${model.name}`
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
                                    ? t("Loading...")
                                    : t("Unloading...")
                                  : running
                                    ? t("Unload")
                                    : t("Load")}
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
                locale={locale}
                setLocale={setLocale}
                appVersion={appVersion}
                catalog={catalog}
                catalogUpdatedAt={catalogUpdatedAt}
                catalogRefreshError={
                  catalogRefreshError ===
                  JSON.stringify([
                    catalogQuery.trim(),
                    catalogSort,
                    catalogCapability,
                  ])
                }
                catalogModelDetails={catalogModelDetails}
                loadCatalogModelDetails={loadCatalogModelDetails}
                catalogQuery={catalogQuery}
                setCatalogQuery={setCatalogQuery}
                catalogSort={catalogSort}
                setCatalogSort={setCatalogSort}
                catalogCapability={catalogCapability}
                setCatalogCapability={setCatalogCapability}
                retryCatalog={retryCatalog}
                loadMoreCatalog={loadMoreCatalog}
                downloads={downloads}
                startDownload={downloadModel}
                pauseDownload={pauseDownload}
                cancelDownload={cancelDownload}
              />
            )}
          </section>
          {isModelView && (
            <aside className="inspector" aria-label={t("Model inspector")}>
              <div className="inspector-caption">
                <span>{t("MODEL INSPECTOR")}</span>
                {selectedModel && (
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={t("Back to models")}
                    title={t("Back to models")}
                    onClick={() => setSelectedModel(null)}
                  >
                    <X size={16} />
                  </button>
                )}
              </div>
              {!selectedModel && (
                <div className="empty-state inspector-empty">
                  <Box size={38} strokeWidth={1.3} />
                  <h3>{t("Select a model")}</h3>
                  <p>{t("Details, configuration and model actions.")}</p>
                </div>
              )}
              {connection.state === "connected" && selectedModel !== null && (
                <div className="model-details" aria-labelledby="details-title">
                  <div className="inspector-model-icon">
                    <Box size={26} />
                  </div>
                  <span className="eyebrow">{t("LOCAL MODEL")}</span>
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
                    {t("Open in Chat")}
                    <ChevronRight size={14} />
                  </button>
                  <div role="status" aria-live="polite">
                    {details.state === "loading" && (
                      <p>{t("Loading model details...")}</p>
                    )}
                    {details.state === "error" && (
                      <p>{t("Could not load model details")}</p>
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
                      ].some(Boolean) && (
                        <p>{t("Model details unavailable")}</p>
                      )}
                  </div>
                  {details.state === "error" && (
                    <button type="button" onClick={retryDetails}>
                      {t("Retry details")}
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
                          [t("Format"), details.value.format],
                          [t("Family"), details.value.family],
                          [t("Parameters"), details.value.parameter_size],
                          [t("Quantization"), details.value.quantization_level],
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
                          [t("Model parameters"), details.value.parameters],
                          [t("Prompt template"), details.value.template],
                          [t("System prompt"), details.value.system],
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
                            <summary>{t("Model information")}</summary>
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
                      <h3>{t("Manage model")}</h3>
                      <span className="preview-label">{t("Pending")}</span>
                    </div>
                    <button disabled aria-label={t("Rename model")}>
                      <Pencil size={15} />
                      {t("Rename")}
                    </button>
                    <button disabled aria-label={t("Duplicate model")}>
                      <Copy size={15} />
                      {t("Duplicate")}
                    </button>
                    <button
                      disabled
                      aria-label={t("Delete model")}
                      className="danger"
                    >
                      <Trash2 size={15} />
                      {t("Delete model")}
                    </button>
                    <span className="quiet-note">
                      {t("Model management is not connected yet.")}
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
          Lokvyn <span>{appVersion || t("Version unavailable")}</span>
        </span>
        <span className="connection" role="status">
          <i
            className={`status-dot ${connection.state === "connected" ? "online" : ""}`}
          />
          {connection.state === "connected" ? (
            <>
              <span>{t("Connected")}</span>
              <span className="version">
                {t("Version")} {connection.version}
              </span>
            </>
          ) : connection.state === "connecting" ? (
            t("Connecting")
          ) : (
            t("Disconnected")
          )}
        </span>
        <span className="footer-end">
          <Server size={13} />
          {t("Local Ollama")}
          <span className="development-label">{t("Development build")}</span>
        </span>
      </footer>
    </div>
  );
}
