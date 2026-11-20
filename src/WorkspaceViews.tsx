import { useEffect, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowUp,
  Box,
  Check,
  CircleDashed,
  Download,
  KeyRound,
  MessageSquare,
  Pause,
  Play,
  Search,
  Server,
  X,
} from "lucide-react";
import { translate, type Locale } from "./i18n";
import { Select, TextArea, TextInput } from "./FormControls";

export type View =
  | "Discover"
  | "Installed models"
  | "Running models"
  | "Downloads"
  | "Chat"
  | "API access"
  | "Settings";

export type CatalogModel = {
  name: string;
  description: string;
  capabilities: string[];
  cloud?: boolean;
  downloads: string | null;
  sizes: string[];
  downloadSize?: string | null;
  variants?: { tag: string; downloadSize: string | null }[];
};

type Catalog = {
  state: "idle" | "loading" | "loaded" | "error";
  models: CatalogModel[];
  page: number;
  hasMore: boolean;
  loadingMore: boolean;
  loadMoreError: boolean;
};

type DownloadTask = {
  model: string;
  state: "queued" | "downloading" | "paused" | "completed" | "error";
  message: string;
  completed: number | null;
  total: number | null;
};

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = -1;
  do {
    value /= 1024;
    unit += 1;
  } while (value >= 1024 && unit < units.length - 1);
  return `${value.toFixed(1)} ${units[unit]}`;
}

function parseCatalogSizeValues(value: string | null | undefined) {
  const unitMultipliers: Record<string, number> = {
    B: 1,
    KB: 1024,
    MB: 1024 ** 2,
    GB: 1024 ** 3,
    TB: 1024 ** 4,
  };
  return [...(value ?? "").matchAll(/(\d+(?:\.\d+)?)\s*(TB|GB|MB|KB|B)\b/gi)]
    .map((match) => {
      const unit = match[2].toUpperCase();
      const amount = Number(match[1]);
      return {
        bytes: amount * unitMultipliers[unit],
        label: `${match[1]}${unit}`,
      };
    })
    .filter((size) => Number.isFinite(size.bytes));
}

function modelCatalogSize(model: CatalogModel) {
  const variants = model.variants ?? [];
  const parameterVariants = variants.filter((variant) =>
    model.sizes.includes(variant.tag),
  );
  const summaryVariants =
    parameterVariants.length > 0 ? parameterVariants : variants;
  const sizes = summaryVariants.flatMap((variant) =>
    parseCatalogSizeValues(variant.downloadSize),
  );
  if (sizes.length === 0) return model.downloadSize ?? "-";

  const smallest = sizes.reduce((current, size) =>
    size.bytes < current.bytes ? size : current,
  );
  const largest = sizes.reduce((current, size) =>
    size.bytes > current.bytes ? size : current,
  );
  return smallest.bytes === largest.bytes
    ? smallest.label
    : `${smallest.label} - ${largest.label}`;
}

function variantsForParameter(
  variants: CatalogModel["variants"],
  parameterSize: string,
) {
  return (variants ?? []).filter(
    (variant) =>
      variant.tag === parameterSize ||
      variant.tag.startsWith(`${parameterSize}-`),
  );
}

function ModelSelector({
  models,
  model,
  setModel,
  locale,
}: {
  models: string[];
  model: string;
  setModel: (model: string) => void;
  locale: Locale;
}) {
  const t = (source: string) => translate(locale, source);
  return (
    <Select
      label={t("Select model")}
      value={model}
      onChange={setModel}
      options={[
        { value: "", label: t("Select an installed model") },
        ...models.map((name) => ({ value: name, label: name })),
      ]}
    />
  );
}

export default function WorkspaceViews({
  view,
  models,
  chatModel,
  setChatModel,
  connected,
  locale,
  setLocale,
  appVersion,
  catalog,
  catalogQuery,
  setCatalogQuery,
  catalogSort,
  setCatalogSort,
  catalogCapability,
  setCatalogCapability,
  retryCatalog,
  loadMoreCatalog,
  downloads,
  startDownload,
  pauseDownload,
  cancelDownload,
}: {
  view: View;
  models: string[];
  chatModel: string;
  setChatModel: (model: string) => void;
  connected: boolean;
  locale: Locale;
  setLocale: (locale: Locale) => void;
  appVersion: string;
  catalog: Catalog;
  catalogQuery: string;
  setCatalogQuery: (query: string) => void;
  catalogSort: string;
  setCatalogSort: (sort: string) => void;
  catalogCapability: string;
  setCatalogCapability: (capability: string) => void;
  retryCatalog: () => void;
  loadMoreCatalog: () => void;
  downloads: DownloadTask[];
  startDownload: (model: string) => void;
  pauseDownload: (model: string) => void;
  cancelDownload: (model: string) => void;
}) {
  const t = (source: string) => translate(locale, source);
  const [apiModel, setApiModel] = useState("");
  const [selectedModelSizes, setSelectedModelSizes] = useState<
    Record<string, string>
  >({});
  const [choosingModelVariant, setChoosingModelVariant] = useState<{
    modelName: string;
    parameterSize: string | null;
  } | null>(null);
  const catalogEndRef = useRef<HTMLDivElement>(null);
  const loadMoreCatalogRef = useRef(loadMoreCatalog);
  const autoLoadPending = useRef(false);
  const selectedChat = models.includes(chatModel) ? chatModel : "";
  const selectedApi = models.includes(apiModel) ? apiModel : "";
  const cancelModelDownload = (model: string) => {
    cancelDownload(model);
    const modelName = model.split(":")[0];
    setSelectedModelSizes((current) => {
      if (!(modelName in current)) return current;
      const next = { ...current };
      delete next[modelName];
      return next;
    });
  };

  useEffect(() => {
    loadMoreCatalogRef.current = loadMoreCatalog;
  }, [loadMoreCatalog]);

  useEffect(() => {
    if (!catalog.loadingMore) autoLoadPending.current = false;
    if (
      view !== "Discover" ||
      catalog.state !== "loaded" ||
      !catalog.hasMore ||
      catalog.loadMoreError ||
      catalog.loadingMore ||
      !catalogEndRef.current ||
      typeof IntersectionObserver === "undefined"
    )
      return;

    const observer = new IntersectionObserver((entries) => {
      if (
        entries.some((entry) => entry.isIntersecting) &&
        !autoLoadPending.current
      ) {
        autoLoadPending.current = true;
        loadMoreCatalogRef.current();
      }
    });
    observer.observe(catalogEndRef.current);
    return () => observer.disconnect();
  }, [
    catalog.hasMore,
    catalog.loadMoreError,
    catalog.loadingMore,
    catalog.state,
    view,
  ]);

  if (view === "Discover") {
    return (
      <section className="discover-view">
        <div className="directory-heading">
          <h2>{t("Ollama library")}</h2>
          <span className="directory-count" aria-live="polite">
            {catalog.state === "loaded"
              ? `${catalog.models.length}${catalog.hasMore ? "+" : ""} ${t("models shown")}`
              : ""}
          </span>
          <span className="preview-label">{t("Live catalog")}</span>
        </div>
        <div className="filter-bar">
          <label className="search-field">
            <Search size={16} />
            <TextInput
              type="search"
              aria-label={t("Search models")}
              placeholder={t("Search Ollama models...")}
              value={catalogQuery}
              onChange={(event) => setCatalogQuery(event.target.value)}
            />
          </label>
          <Select
            label={t("Capability")}
            value={catalogCapability}
            onChange={setCatalogCapability}
            options={[
              { value: "", label: t("All capabilities") },
              ...[
                "vision",
                "tools",
                "thinking",
                "embedding",
                "decision",
                "audio",
                "local",
                "cloud",
              ].map((value) => ({ value, label: t(value) })),
            ]}
          />
          <Select
            label={t("Sort by")}
            value={catalogSort}
            onChange={setCatalogSort}
            options={["popular", "newest", "name", "price", "context"].map(
              (value) => ({ value, label: t(value) }),
            )}
          />
        </div>
        <p className="quiet-note">
          {t("Catalog data is provided by the Ollama library.")}
        </p>
        <table className="model-directory" aria-label={t("Model directory")}>
          <thead>
            <tr>
              <th scope="col">{t("Model family")}</th>
              <th scope="col" className="directory-capability">
                {t("Capability")}
              </th>
              <th scope="col" className="directory-size">
                {t("Size")}
              </th>
              <th scope="col" className="directory-downloads">
                {t("Downloads")}
              </th>
              <th scope="col" className="directory-action">
                {t("Download")}
              </th>
            </tr>
          </thead>
          <tbody>
            {catalog.state === "loaded" &&
              catalog.models.map((model) => {
                const savedTag = selectedModelSizes[model.name] ?? "";
                const selectedTag =
                  model.sizes.includes(savedTag) ||
                  model.variants?.some((variant) => variant.tag === savedTag)
                    ? savedTag
                    : model.sizes.length === 1
                      ? model.sizes[0]
                      : (model.sizes.find((size) =>
                          models.includes(`${model.name}:${size}`),
                        ) ?? "");
                const selectedParameterSize = model.sizes.find(
                  (size) =>
                    selectedTag === size || selectedTag.startsWith(`${size}-`),
                );
                const targetModel = selectedTag
                  ? `${model.name}:${selectedTag}`
                  : model.name;
                const installed = models.some(
                  (name) =>
                    name === targetModel ||
                    (!selectedTag && name === `${model.name}:latest`),
                );
                const task = downloads.find(
                  (item) =>
                    !model.cloud &&
                    (item.model === targetModel ||
                      (item.model.split(":")[0] === model.name &&
                        ["queued", "downloading", "paused"].includes(
                          item.state,
                        ))),
                );
                const catalogSize = modelCatalogSize(model);
                const sizeOptions = model.sizes.map((size) => {
                  const downloadSize = model.variants?.find(
                    (variant) => variant.tag === size,
                  )?.downloadSize;
                  return {
                    value: size,
                    label: downloadSize ? `${size} · ${downloadSize}` : size,
                  };
                });
                const quantizationOptions =
                  choosingModelVariant?.modelName === model.name &&
                  choosingModelVariant.parameterSize
                    ? variantsForParameter(
                        model.variants,
                        choosingModelVariant.parameterSize,
                      )
                    : [];
                const recommendedTag = choosingModelVariant?.parameterSize
                  ? (quantizationOptions.find((variant) =>
                      variant.tag.toLowerCase().endsWith("-q4_k_m"),
                    )?.tag ??
                    quantizationOptions.find(
                      (variant) =>
                        variant.tag === choosingModelVariant.parameterSize,
                    )?.tag ??
                    quantizationOptions[0]?.tag)
                  : undefined;
                return (
                  <tr key={model.name}>
                    <th scope="row">
                      <div className="directory-model">
                        <div>
                          <strong>{model.name}</strong>
                          <p>{model.description}</p>
                          {model.sizes.length > 0 && (
                            <span className="model-size-hints">
                              {model.sizes.join(" · ")}
                            </span>
                          )}
                          {choosingModelVariant?.modelName === model.name && (
                            <div className="model-variant-picker">
                              {choosingModelVariant.parameterSize === null ? (
                                <>
                                  <span className="variant-choice-label">
                                    {t("Select model size")}
                                  </span>
                                  <div
                                    className="model-variant-options"
                                    role="group"
                                    aria-label={`${t("Select model size")}: ${model.name}`}
                                  >
                                    {sizeOptions.map((option) => (
                                      <button
                                        className="model-variant-option"
                                        type="button"
                                        key={option.value}
                                        disabled={!connected}
                                        onClick={() => {
                                          const variants = variantsForParameter(
                                            model.variants,
                                            option.value,
                                          );
                                          if (variants.length > 1) {
                                            setChoosingModelVariant({
                                              modelName: model.name,
                                              parameterSize: option.value,
                                            });
                                            return;
                                          }
                                          const tag =
                                            variants[0]?.tag ?? option.value;
                                          setSelectedModelSizes((current) => ({
                                            ...current,
                                            [model.name]: tag,
                                          }));
                                          setChoosingModelVariant(null);
                                          startDownload(`${model.name}:${tag}`);
                                        }}
                                      >
                                        {option.label}
                                      </button>
                                    ))}
                                  </div>
                                </>
                              ) : (
                                <>
                                  <span className="variant-choice-label">
                                    {t("Select quantization version")}
                                  </span>
                                  <div
                                    className="model-variant-options quantization-options"
                                    role="group"
                                    aria-label={`${t("Select quantization version")}: ${model.name}:${choosingModelVariant.parameterSize}`}
                                  >
                                    {quantizationOptions.map((variant) => {
                                      const recommended =
                                        variant.tag === recommendedTag;
                                      return (
                                        <button
                                          className={`model-variant-option quantization-option${recommended ? " recommended" : ""}`}
                                          type="button"
                                          key={variant.tag}
                                          disabled={!connected}
                                          aria-label={`${model.name}:${variant.tag} · ${variant.downloadSize ?? t("Size unavailable")}${recommended ? ` · ${t("Recommended")}` : ""}`}
                                          onClick={() => {
                                            setSelectedModelSizes(
                                              (current) => ({
                                                ...current,
                                                [model.name]: variant.tag,
                                              }),
                                            );
                                            setChoosingModelVariant(null);
                                            startDownload(
                                              `${model.name}:${variant.tag}`,
                                            );
                                          }}
                                        >
                                          <span className="quantization-tag">
                                            {model.name}:{variant.tag}
                                          </span>
                                          <span className="quantization-size">
                                            {variant.downloadSize ??
                                              t("Size unavailable")}
                                          </span>
                                          {recommended && (
                                            <span className="quantization-recommended">
                                              {t("Recommended")}
                                            </span>
                                          )}
                                        </button>
                                      );
                                    })}
                                  </div>
                                  {model.sizes.length > 1 && (
                                    <button
                                      className="variant-back-button"
                                      type="button"
                                      onClick={() =>
                                        setChoosingModelVariant({
                                          modelName: model.name,
                                          parameterSize: null,
                                        })
                                      }
                                    >
                                      {t("Change model size")}
                                    </button>
                                  )}
                                </>
                              )}
                            </div>
                          )}
                          {(task?.state === "queued" ||
                            task?.state === "downloading" ||
                            task?.state === "paused") && (
                            <div
                              className={`download-model-progress ${task.state}`}
                            >
                              <span
                                className="download-model-state"
                                role="status"
                              >
                                <CircleDashed
                                  className={
                                    task.state === "downloading"
                                      ? "download-model-spinner"
                                      : undefined
                                  }
                                  size={13}
                                  aria-hidden="true"
                                />
                                {t(
                                  task.state === "queued"
                                    ? "Queued"
                                    : task.state === "paused"
                                      ? "Download paused"
                                      : "Downloading",
                                )}
                              </span>
                              {task.state === "downloading" && (
                                <div
                                  className="download-model-progress-track"
                                  role="progressbar"
                                  aria-label={`${t("Downloading")} ${model.name}`}
                                  aria-valuemin={0}
                                  aria-valuemax={100}
                                  aria-valuenow={
                                    task.total && task.completed !== null
                                      ? Math.round(
                                          (task.completed / task.total) * 100,
                                        )
                                      : undefined
                                  }
                                >
                                  <span
                                    className={
                                      task.total ? "" : "indeterminate"
                                    }
                                    style={{
                                      width:
                                        task.total && task.completed !== null
                                          ? `${Math.min(100, (task.completed / task.total) * 100)}%`
                                          : undefined,
                                    }}
                                  />
                                </div>
                              )}
                            </div>
                          )}
                          {task?.state === "error" && (
                            <span
                              className="download-model-state failed"
                              role="status"
                              title={task.message}
                            >
                              {t("Download failed")}
                            </span>
                          )}
                        </div>
                      </div>
                    </th>
                    <td className="directory-capability">
                      <div className="capability-list">
                        {model.cloud && (
                          <span className="capability capability-cloud">
                            {t("cloud")}
                          </span>
                        )}
                        {model.capabilities.map((value) => (
                          <span className="capability" key={value}>
                            {t(value)}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="directory-size">{catalogSize}</td>
                    <td className="directory-downloads">
                      {model.downloads ?? "-"}
                    </td>
                    <td className="directory-action">
                      {model.cloud ? (
                        <span
                          className="cloud-only-label"
                          title={t(
                            "Cloud-only models run remotely and cannot be downloaded locally.",
                          )}
                        >
                          {t("Cloud only")}
                        </span>
                      ) : installed ? (
                        <span className="installed-label">
                          {t("Installed")}
                        </span>
                      ) : task?.state === "downloading" ? (
                        <div className="directory-download-actions">
                          <button
                            className="icon-button"
                            type="button"
                            aria-label={`${t("Pause")} ${model.name}`}
                            title={t("Pause")}
                            onClick={() => pauseDownload(task.model)}
                          >
                            <Pause size={15} aria-hidden="true" />
                          </button>
                          <button
                            className="icon-button destructive"
                            type="button"
                            aria-label={`${t("Cancel download")} ${model.name}`}
                            title={t("Cancel download")}
                            onClick={() => cancelModelDownload(task.model)}
                          >
                            <X size={15} aria-hidden="true" />
                          </button>
                        </div>
                      ) : task?.state === "paused" ? (
                        <div className="directory-download-actions">
                          <button
                            className="icon-button"
                            type="button"
                            aria-label={`${t("Resume")} ${model.name}`}
                            title={t("Resume")}
                            disabled={!connected}
                            onClick={() => startDownload(task.model)}
                          >
                            <Play size={15} aria-hidden="true" />
                          </button>
                          <button
                            className="icon-button destructive"
                            type="button"
                            aria-label={`${t("Cancel download")} ${model.name}`}
                            title={t("Cancel download")}
                            onClick={() => cancelModelDownload(task.model)}
                          >
                            <X size={15} aria-hidden="true" />
                          </button>
                        </div>
                      ) : task?.state === "queued" ? (
                        <div className="directory-download-actions">
                          <button
                            className="icon-button destructive"
                            type="button"
                            aria-label={`${t("Cancel download")} ${model.name}`}
                            title={t("Cancel download")}
                            onClick={() => cancelModelDownload(task.model)}
                          >
                            <X size={15} aria-hidden="true" />
                          </button>
                        </div>
                      ) : choosingModelVariant?.modelName === model.name ? (
                        <button
                          className="icon-button destructive"
                          type="button"
                          aria-label={`${t("Cancel size selection")} ${model.name}`}
                          title={t("Cancel size selection")}
                          onClick={() => setChoosingModelVariant(null)}
                        >
                          <X size={15} aria-hidden="true" />
                        </button>
                      ) : (
                        <button
                          className="icon-button"
                          aria-label={`${t("Download")} ${model.name}`}
                          title={t(
                            task?.state === "error"
                              ? "Retry download"
                              : "Download model",
                          )}
                          disabled={!connected}
                          onClick={() => {
                            if (!selectedTag && model.sizes.length > 1) {
                              setChoosingModelVariant({
                                modelName: model.name,
                                parameterSize: null,
                              });
                              return;
                            }
                            if (
                              selectedParameterSize &&
                              variantsForParameter(
                                model.variants,
                                selectedParameterSize,
                              ).length > 1
                            ) {
                              setChoosingModelVariant({
                                modelName: model.name,
                                parameterSize: selectedParameterSize,
                              });
                              return;
                            }
                            startDownload(targetModel);
                          }}
                        >
                          <ArrowDownToLine size={17} />
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
          </tbody>
        </table>
        {catalog.state === "loading" && (
          <div className="empty-state">
            <CircleDashed size={26} />
            <p>{t("Loading Ollama models...")}</p>
          </div>
        )}
        {catalog.state === "error" && (
          <div className="empty-state">
            <Server size={26} />
            <h3>{t("Could not load the Ollama catalog")}</h3>
            <p>{t("Check your internet connection and retry.")}</p>
            <button type="button" onClick={retryCatalog}>
              {t("Retry catalog")}
            </button>
          </div>
        )}
        {catalog.state === "loaded" && catalog.models.length === 0 && (
          <div className="empty-state">
            <Search size={30} />
            <h3>{t("No matching models")}</h3>
            <p>{t("Try another model name or filter.")}</p>
          </div>
        )}
        {catalog.state === "loaded" && catalog.hasMore && (
          <div
            className="catalog-pagination"
            ref={catalogEndRef}
            data-testid="catalog-end"
          >
            {catalog.loadingMore && (
              <span className="catalog-loading" role="status">
                {t("Loading...")}
              </span>
            )}
            {catalog.loadMoreError && (
              <>
                <span role="status">{t("Could not load more models")}</span>
                <button type="button" onClick={loadMoreCatalog}>
                  {t("Retry loading more")}
                </button>
              </>
            )}
          </div>
        )}
      </section>
    );
  }
  if (view === "Downloads")
    return (
      <section className="full-view">
        <div className="section-toolbar">
          <span>{t("Download queue")}</span>
          <span>
            {downloads.length} {t("tasks")}
          </span>
        </div>
        {downloads.length === 0 ? (
          <div className="empty-state">
            <Download size={40} strokeWidth={1.4} />
            <h2>{t("No download tasks")}</h2>
            <p>
              {t("Download a model from Discover to see its progress here.")}
            </p>
          </div>
        ) : (
          <ul className="download-list">
            {downloads.map((task) => (
              <li className="download-item" key={task.model}>
                <div className="download-item-heading">
                  <strong>{task.model}</strong>
                  <span className={`download-state ${task.state}`}>
                    {t(task.state)}
                  </span>
                </div>
                <div className="download-item-detail">
                  <span>{task.message}</span>
                  {task.total !== null && task.completed !== null && (
                    <span>
                      {formatBytes(task.completed)} / {formatBytes(task.total)}
                    </span>
                  )}
                </div>
                {task.state === "downloading" && (
                  <div
                    className="download-progress"
                    role="progressbar"
                    aria-label={t("Download progress")}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={
                      task.total && task.completed !== null
                        ? Math.round((task.completed / task.total) * 100)
                        : undefined
                    }
                  >
                    <span
                      className={task.total ? "" : "indeterminate"}
                      style={{
                        width:
                          task.total && task.completed !== null
                            ? `${Math.min(100, (task.completed / task.total) * 100)}%`
                            : undefined,
                      }}
                    />
                  </div>
                )}
                {task.state === "error" && (
                  <button
                    type="button"
                    onClick={() => startDownload(task.model)}
                    disabled={
                      !connected ||
                      downloads.some((item) => item.state === "downloading")
                    }
                  >
                    <ArrowDownToLine size={15} />
                    {t("Retry download")}
                  </button>
                )}
                {(task.state === "downloading" || task.state === "queued") && (
                  <div className="download-item-actions">
                    <button
                      type="button"
                      aria-label={`${t("Pause")} ${task.model}`}
                      onClick={() => pauseDownload(task.model)}
                    >
                      <Pause size={15} />
                      {t("Pause")}
                    </button>
                    <button
                      type="button"
                      aria-label={`${t("Cancel download")} ${task.model}`}
                      onClick={() => cancelModelDownload(task.model)}
                    >
                      <X size={15} />
                      {t("Cancel download")}
                    </button>
                  </div>
                )}
                {task.state === "paused" && (
                  <div className="download-item-actions">
                    <button
                      type="button"
                      aria-label={`${t("Resume")} ${task.model}`}
                      onClick={() => startDownload(task.model)}
                      disabled={!connected}
                    >
                      <Play size={15} />
                      {t("Resume")}
                    </button>
                    <button
                      type="button"
                      aria-label={`${t("Cancel download")} ${task.model}`}
                      onClick={() => cancelModelDownload(task.model)}
                    >
                      <X size={15} />
                      {t("Cancel download")}
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        <div className="view-footnote">
          {t("Downloads are stored and managed by Ollama.")}
        </div>
      </section>
    );
  if (view === "Chat")
    return (
      <section className="chat-view">
        <div className="section-toolbar">
          <div className="inline">
            <MessageSquare size={16} />
            <ModelSelector
              models={models}
              model={selectedChat}
              setModel={setChatModel}
              locale={locale}
            />
          </div>
          <span className="preview-label">{t("Not connected")}</span>
        </div>
        <div className="empty-state">
          <MessageSquare size={42} strokeWidth={1.3} />
          <h2>{selectedChat || t("A conversation, locally.")}</h2>
          <p>{t("Chat generation is not connected yet.")}</p>
        </div>
        <div className="composer">
          <TextArea
            aria-label={t("Message")}
            placeholder={t("Message your local model...")}
            disabled
            rows={3}
          />
          <div>
            <span>{t("Local model · Chat pending")}</span>
            <button
              className="icon-button primary"
              aria-label={t("Send message")}
              title={t("Chat not connected")}
              disabled
            >
              <ArrowUp size={18} />
            </button>
          </div>
        </div>
      </section>
    );
  if (view === "API access")
    return (
      <section className="api-view">
        <div className="view-heading">
          <div>
            <h2>{t("Model access")}</h2>
            <p>{t("Manage how applications will connect to your models.")}</p>
          </div>
          <span className="preview-label">{t("Gateway not configured")}</span>
        </div>
        <div className="settings-section">
          <h3>
            <Server size={17} />
            {t("Ollama endpoint")}
          </h3>
          <dl className="setting-list">
            <div>
              <dt>{t("Local endpoint")}</dt>
              <dd>
                <code>http://127.0.0.1:11434</code>
              </dd>
            </div>
            <div>
              <dt>{t("Authentication")}</dt>
              <dd>{t("No Lokvyn key protection")}</dd>
            </div>
            <div>
              <dt>{t("Model")}</dt>
              <dd>
                <ModelSelector
                  models={models}
                  model={selectedApi}
                  setModel={setApiModel}
                  locale={locale}
                />
              </dd>
            </div>
          </dl>
        </div>
        <div className="settings-section">
          <div className="section-heading">
            <h3>
              <KeyRound size={17} />
              {t("API keys")}
            </h3>
            <button disabled>
              <KeyRound size={16} />
              {t("Create API key")}
            </button>
          </div>
          <div className="empty-state compact">
            <KeyRound size={30} />
            <h3>{t("No API keys")}</h3>
            <p>
              {t(
                "Key management requires a Lokvyn gateway. No gateway is running.",
              )}
            </p>
          </div>
        </div>
      </section>
    );
  return (
    <section className="settings-view">
      <div className="view-heading">
        <div>
          <h2>{t("Local workspace")}</h2>
          <p>{t("Connection and application information.")}</p>
        </div>
      </div>
      <div className="settings-section">
        <h3>
          <Server size={17} />
          {t("Connection")}
        </h3>
        <dl className="setting-list">
          <div>
            <dt>{t("Service")}</dt>
            <dd>Ollama</dd>
          </div>
          <div>
            <dt>{t("Address")}</dt>
            <dd>
              <code>127.0.0.1:11434</code>
            </dd>
          </div>
          <div>
            <dt>{t("Status")}</dt>
            <dd className="inline">
              {connected ? <Check size={16} /> : <CircleDashed size={16} />}
              {t(connected ? "Available" : "Unavailable")}
            </dd>
          </div>
          <div>
            <dt>{t("Endpoint configuration")}</dt>
            <dd>{t("Read only")}</dd>
          </div>
        </dl>
      </div>
      <div className="settings-section">
        <h3>
          <Box size={17} />
          {t("Application")}
        </h3>
        <dl className="setting-list">
          <div>
            <dt>{t("Application version")}</dt>
            <dd>{appVersion || t("Version unavailable")}</dd>
          </div>
          <div>
            <dt>{t("Model service")}</dt>
            <dd>{t("Local Ollama")}</dd>
          </div>
          <div>
            <dt>{t("Storage")}</dt>
            <dd>{t("No saved conversations or keys")}</dd>
          </div>
        </dl>
      </div>
      <div className="settings-section language-section">
        <h3>{t("Language")}</h3>
        <div className="language-setting">
          <span>{t("Language")}</span>
          <Select
            label={t("Language")}
            value={locale}
            onChange={(value) => setLocale(value as Locale)}
            options={[
              { value: "en", label: "English" },
              { value: "zh-CN", label: "简体中文" },
            ]}
          />
        </div>
      </div>
    </section>
  );
}
