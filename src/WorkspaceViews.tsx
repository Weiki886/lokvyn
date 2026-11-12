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
}: {
  models: string[];
  model: string;
  setModel: (model: string) => void;
}) {
  return (
    <select
      aria-label="Select model"
      value={model}
      onChange={(event) => setModel(event.target.value)}
    >
      <option value="">Select an installed model</option>
      {models.map((name) => (
        <option key={name} value={name}>
          {name}
        </option>
      ))}
    </select>
  );
}

export default function WorkspaceViews({
  view,
  models,
  chatModel,
  setChatModel,
  connected,
}: {
  view: View;
  models: string[];
  chatModel: string;
  setChatModel: (model: string) => void;
  connected: boolean;
}) {
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
            <h2>Find your next model</h2>
            <p>Explore model families from the Ollama library.</p>
          </div>
          <span className="preview-label">Catalog preview</span>
        </div>
        <div className="filter-bar">
          <label className="search-field">
            <Search size={16} />
            <input
              type="search"
              aria-label="Search catalog preview"
              placeholder="Search model families..."
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <select
            aria-label="Capability"
            value={capability}
            onChange={(event) => setCapability(event.target.value)}
          >
            {["All capabilities", "Chat", "Vision", "Code", "Embedding"].map(
              (value) => (
                <option key={value}>{value}</option>
              ),
            )}
          </select>
        </div>
        <p className="quiet-note">
          Selected examples only. Live catalog and downloads are not connected.
        </p>
        <div className="catalog-grid">
          {filtered.map((model) => (
            <article className="catalog-item" key={model.name}>
              <div className="catalog-identity">
                <span className="family-mark">{model.mark}</span>
                <span className="capability">{model.capability}</span>
              </div>
              <h3>{model.name}</h3>
              <p>{model.description}</p>
              <div className="catalog-bottom">
                <span>{model.tags}</span>
                <button
                  className="icon-button"
                  aria-label={`Download ${model.name}`}
                  title="Downloads not connected"
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
            <h3>No matching models</h3>
            <p>Try another name or capability.</p>
          </div>
        )}
      </section>
    );
  }
  if (view === "Downloads")
    return (
      <section className="full-view">
        <div className="section-toolbar">
          <span>Download queue</span>
          <span className="preview-label">Not connected</span>
        </div>
        <div className="empty-state">
          <Download size={40} strokeWidth={1.4} />
          <h2>No download tasks</h2>
          <p>Model downloads are not connected yet.</p>
          <button disabled>
            <ArrowDownToLine size={16} />
            Add download
          </button>
        </div>
        <div className="view-footnote">Queue · Progress · Retry</div>
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
            />
          </div>
          <span className="preview-label">Not connected</span>
        </div>
        <div className="empty-state">
          <MessageSquare size={42} strokeWidth={1.3} />
          <h2>{selectedChat || "A conversation, locally."}</h2>
          <p>Chat generation is not connected yet.</p>
        </div>
        <div className="composer">
          <textarea
            aria-label="Message"
            placeholder="Message your local model..."
            disabled
            rows={3}
          />
          <div>
            <span>Local model · Chat pending</span>
            <button
              className="icon-button primary"
              aria-label="Send message"
              title="Chat not connected"
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
            <h2>Model access</h2>
            <p>Manage how applications will connect to your models.</p>
          </div>
          <span className="preview-label">Gateway not configured</span>
        </div>
        <div className="settings-section">
          <h3>
            <Server size={17} />
            Ollama endpoint
          </h3>
          <dl className="setting-list">
            <div>
              <dt>Local endpoint</dt>
              <dd>
                <code>http://127.0.0.1:11434</code>
              </dd>
            </div>
            <div>
              <dt>Authentication</dt>
              <dd>No Lokvyn key protection</dd>
            </div>
            <div>
              <dt>Model</dt>
              <dd>
                <ModelSelector
                  models={models}
                  model={selectedApi}
                  setModel={setApiModel}
                />
              </dd>
            </div>
          </dl>
        </div>
        <div className="settings-section">
          <div className="section-heading">
            <h3>
              <KeyRound size={17} />
              API keys
            </h3>
            <button disabled>
              <KeyRound size={16} />
              Create API key
            </button>
          </div>
          <div className="empty-state compact">
            <KeyRound size={30} />
            <h3>No API keys</h3>
            <p>
              Key management requires a Lokvyn gateway. No gateway is running.
            </p>
          </div>
        </div>
      </section>
    );
  return (
    <section className="settings-view">
      <div className="view-heading">
        <div>
          <h2>Local workspace</h2>
          <p>Connection and application information.</p>
        </div>
      </div>
      <div className="settings-section">
        <h3>
          <Server size={17} />
          Connection
        </h3>
        <dl className="setting-list">
          <div>
            <dt>Service</dt>
            <dd>Ollama</dd>
          </div>
          <div>
            <dt>Address</dt>
            <dd>
              <code>127.0.0.1:11434</code>
            </dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd className="inline">
              {connected ? <Check size={16} /> : <CircleDashed size={16} />}
              {connected ? "Available" : "Unavailable"}
            </dd>
          </div>
          <div>
            <dt>Endpoint configuration</dt>
            <dd>Read only</dd>
          </div>
        </dl>
      </div>
      <div className="settings-section">
        <h3>
          <Box size={17} />
          Application
        </h3>
        <dl className="setting-list">
          <div>
            <dt>Lokvyn</dt>
            <dd>0.1.0 · Development build</dd>
          </div>
          <div>
            <dt>Model service</dt>
            <dd>Local Ollama</dd>
          </div>
          <div>
            <dt>Storage</dt>
            <dd>No saved conversations or keys</dd>
          </div>
        </dl>
      </div>
    </section>
  );
}
