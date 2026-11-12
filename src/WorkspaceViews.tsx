import { useState } from "react";
import {
  ArrowDownToLine,
  ArrowUp,
  Box,
  Check,
  CircleDashed,
  Download,
  KeyRound,
  MessageSquare,
  Search,
  Server,
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

const catalog = [
  {
    name: "qwen3",
    mark: "Q",
    description: "Reasoning and multilingual conversation.",
    capability: "Chat",
    tags: "Reasoning · Multilingual",
  },
  {
    name: "gemma3",
    mark: "G",
    description: "Text and image understanding in one family.",
    capability: "Vision",
    tags: "Vision · Multimodal",
  },
  {
    name: "llama3.2",
    mark: "L",
    description: "Compact models for everyday language tasks.",
    capability: "Chat",
    tags: "Chat · Lightweight",
  },
  {
    name: "deepseek-r1",
    mark: "D",
    description: "A model family focused on reasoning.",
    capability: "Chat",
    tags: "Reasoning · Chat",
  },
  {
    name: "qwen2.5-coder",
    mark: "Q",
    description: "Code generation, completion and understanding.",
    capability: "Code",
    tags: "Code · Completion",
  },
  {
    name: "nomic-embed-text",
    mark: "N",
    description: "Text embeddings for search and retrieval.",
    capability: "Embedding",
    tags: "Embedding · Retrieval",
  },
];

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
}: {
  view: View;
  models: string[];
  chatModel: string;
  setChatModel: (model: string) => void;
  connected: boolean;
  locale: Locale;
  setLocale: (locale: Locale) => void;
  appVersion: string;
}) {
  const t = (source: string) => translate(locale, source);
  const [query, setQuery] = useState("");
  const [capability, setCapability] = useState("All capabilities");
  const [apiModel, setApiModel] = useState("");
  const selectedChat = models.includes(chatModel) ? chatModel : "";
  const selectedApi = models.includes(apiModel) ? apiModel : "";

  if (view === "Discover") {
    const filtered = catalog.filter(
      (model) =>
        model.name.includes(query.trim().toLowerCase()) &&
        (capability === "All capabilities" || model.capability === capability),
    );
    return (
      <section className="discover-view">
        <div className="view-heading">
          <div>
            <h2>{t("Find your next model")}</h2>
            <p>{t("Explore model families from the Ollama library.")}</p>
          </div>
          <span className="preview-label">{t("Catalog preview")}</span>
        </div>
        <div className="filter-bar">
          <label className="search-field">
            <Search size={16} />
            <TextInput
              type="search"
              aria-label={t("Search catalog preview")}
              placeholder={t("Search model families...")}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <Select
            label={t("Capability")}
            value={capability}
            onChange={setCapability}
            options={[
              "All capabilities",
              "Chat",
              "Vision",
              "Code",
              "Embedding",
            ].map((value) => ({ value, label: t(value) }))}
          />
        </div>
        <p className="quiet-note">
          {t(
            "Selected examples only. Live catalog and downloads are not connected.",
          )}
        </p>
        <div className="catalog-grid">
          {filtered.map((model) => (
            <article className="catalog-item" key={model.name}>
              <div className="catalog-identity">
                <span className="family-mark">{model.mark}</span>
                <span className="capability">{t(model.capability)}</span>
              </div>
              <h3>{model.name}</h3>
              <p>{t(model.description)}</p>
              <div className="catalog-bottom">
                <span>{t(model.tags)}</span>
                <button
                  className="icon-button"
                  aria-label={`${t("Download")} ${model.name}`}
                  title={t("Downloads not connected")}
                  disabled
                >
                  <ArrowDownToLine size={17} />
                </button>
              </div>
            </article>
          ))}
        </div>
        {filtered.length === 0 && (
          <div className="empty-state">
            <Search size={30} />
            <h3>{t("No matching models")}</h3>
            <p>{t("Try another name or capability.")}</p>
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
          <span className="preview-label">{t("Not connected")}</span>
        </div>
        <div className="empty-state">
          <Download size={40} strokeWidth={1.4} />
          <h2>{t("No download tasks")}</h2>
          <p>{t("Model downloads are not connected yet.")}</p>
          <button disabled>
            <ArrowDownToLine size={16} />
            {t("Add download")}
          </button>
        </div>
        <div className="view-footnote">{t("Queue · Progress · Retry")}</div>
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
