import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { listen } from "@tauri-apps/api/event";
import App from "./App";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
const ollamaModel = (name: string) => ({
  name,
  size: null,
  modifiedAt: null,
});
beforeEach(() => {
  localStorage.clear();
  vi.mocked(getVersion).mockResolvedValue("0.1.0");
  vi.mocked(listen).mockResolvedValue(() => {});
  vi.mocked(invoke).mockImplementation((command) =>
    Promise.resolve(
      command === "ollama_connection"
        ? "0.1.0"
        : command === "ollama_catalog"
          ? { models: [], page: 1, hasMore: false }
          : [],
    ),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("Ollama connection", () => {
  it("shows the connection state and success", async () => {
    vi.mocked(invoke).mockResolvedValueOnce("0.1.0");
    render(<App />);
    expect(screen.getByText("Connecting to Ollama...")).toBeTruthy();
    expect(await screen.findByText("Connected")).toBeTruthy();
    expect(screen.getByText("Version 0.1.0")).toBeTruthy();
  });

  it("shows failure and retries", async () => {
    vi.mocked(invoke)
      .mockRejectedValueOnce("unavailable")
      .mockResolvedValueOnce("0.2.0");
    render(<App />);
    expect(await screen.findByText("Ollama is unavailable")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry connection" }));
    await waitFor(() => expect(screen.getByText("Connected")).toBeTruthy());
    expect(
      vi
        .mocked(invoke)
        .mock.calls.filter(([name]) => name === "ollama_connection"),
    ).toHaveLength(2);
  });
});

describe("installed models", () => {
  it("shows loading while models are being fetched", async () => {
    vi.mocked(invoke).mockImplementation((command) =>
      command === "ollama_connection"
        ? Promise.resolve("0.1.0")
        : new Promise(() => {}),
    );
    render(<App />);
    expect(await screen.findByText("Loading models...")).toBeTruthy();
  });

  it("loads and refreshes the list", async () => {
    let models: {
      name: string;
      size: number | null;
      modifiedAt: string | null;
    }[] = [
      {
        name: "alpha:latest",
        size: 4_294_967_296,
        modifiedAt: "2025-01-02T03:04:05Z",
      },
    ];
    vi.mocked(invoke).mockImplementation((command) =>
      Promise.resolve(
        command === "ollama_connection"
          ? "0.1.0"
          : command === "ollama_running_models"
            ? []
            : models,
      ),
    );
    render(<App />);
    expect(
      await screen.findByRole("button", { name: "alpha:latest" }),
    ).toBeTruthy();
    expect(screen.getByText("4 GiB")).toBeTruthy();
    expect(
      screen.getByText(
        new Intl.DateTimeFormat("en", {
          dateStyle: "medium",
          timeStyle: "short",
        }).format(new Date("2025-01-02T03:04:05Z")),
      ),
    ).toBeTruthy();
    models = [{ name: "beta:latest", size: null, modifiedAt: null }];
    fireEvent.click(screen.getByRole("button", { name: "Refresh models" }));
    expect(
      await screen.findByRole("button", { name: "beta:latest" }),
    ).toBeTruthy();
    expect(screen.queryByText("alpha:latest")).toBeNull();
  });

  it("keeps models visible when optional metadata is missing or invalid", async () => {
    vi.mocked(invoke).mockImplementation((command) =>
      Promise.resolve(
        command === "ollama_connection"
          ? "0.1.0"
          : command === "ollama_running_models"
            ? []
            : [{ name: "alpha:latest", size: null, modifiedAt: "invalid" }],
      ),
    );
    render(<App />);
    expect(
      await screen.findByRole("button", { name: "alpha:latest" }),
    ).toBeTruthy();
    expect(screen.queryByText(/GiB|MiB|KiB|bytes/)).toBeNull();
  });

  it("shows an empty list", async () => {
    render(<App />);
    expect(await screen.findByText("No models installed")).toBeTruthy();
  });

  it("shows a list error and retries", async () => {
    let fail = true;
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === "ollama_connection") return Promise.resolve("0.1.0");
      return fail
        ? Promise.reject("error")
        : Promise.resolve([ollamaModel("model:latest")]);
    });
    render(<App />);
    expect(await screen.findByText("Could not load models")).toBeTruthy();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry models" }));
    expect(await screen.findByText("model:latest")).toBeTruthy();
  });

  it("shows loaded state and unloads a running model", async () => {
    let running = true;
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === "ollama_connection") return Promise.resolve("0.1.0");
      if (command === "ollama_models")
        return Promise.resolve([ollamaModel("alpha:latest")]);
      if (command === "ollama_running_models")
        return Promise.resolve(
          running
            ? [{ name: "alpha:latest", sizeVram: 1024, expiresAt: null }]
            : [],
        );
      if (command === "ollama_unload_model") {
        running = false;
        return Promise.resolve();
      }
      return Promise.resolve([]);
    });
    render(<App />);
    expect(await screen.findByText("Loaded")).toBeTruthy();
    fireEvent.click(
      await screen.findByRole("button", { name: "Unload alpha:latest" }),
    );
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("ollama_unload_model", {
        modelName: "alpha:latest",
      }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Load alpha:latest" }),
      ).toBeTruthy(),
    );
    expect(screen.queryByText("Loaded")).toBeNull();
    expect(screen.queryByText(/Model state could not be confirmed/)).toBeNull();
  });

  it("loads a model and disables conflicting actions while pending", async () => {
    let resolveLoad: (() => void) | undefined;
    let running = false;
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === "ollama_connection") return Promise.resolve("0.1.0");
      if (command === "ollama_models")
        return Promise.resolve([ollamaModel("alpha:latest")]);
      if (command === "ollama_running_models")
        return Promise.resolve(
          running
            ? [{ name: "alpha:latest", sizeVram: null, expiresAt: null }]
            : [],
        );
      if (command === "ollama_load_model")
        return new Promise<void>((resolve) => {
          resolveLoad = () => {
            running = true;
            resolve();
          };
        });
      return Promise.resolve([]);
    });
    render(<App />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Load alpha:latest" }),
    );
    const loadingButton = await screen.findByRole("button", {
      name: "Loading alpha:latest",
    });
    expect(loadingButton.hasAttribute("disabled")).toBe(true);
    resolveLoad?.();
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("ollama_load_model", {
        modelName: "alpha:latest",
      }),
    );
    expect(await screen.findByText("Loaded")).toBeTruthy();
  });

  it("reconciles status after a failed load and allows retry", async () => {
    let fail = true;
    let running = false;
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === "ollama_connection") return Promise.resolve("0.1.0");
      if (command === "ollama_models")
        return Promise.resolve([ollamaModel("alpha:latest")]);
      if (command === "ollama_running_models")
        return Promise.resolve(
          running
            ? [{ name: "alpha:latest", sizeVram: null, expiresAt: null }]
            : [],
        );
      if (command === "ollama_load_model") {
        if (fail) return Promise.reject("timeout");
        running = true;
        return Promise.resolve();
      }
      return Promise.resolve([]);
    });
    render(<App />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Load alpha:latest" }),
    );
    expect(
      await screen.findByText(/Model state could not be confirmed/),
    ).toBeTruthy();
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "Load alpha:latest" })
          .hasAttribute("disabled"),
      ).toBe(false),
    );
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Load alpha:latest" }));
    await waitFor(() =>
      expect(
        vi
          .mocked(invoke)
          .mock.calls.filter(([name]) => name === "ollama_running_models"),
      ).toHaveLength(3),
    );
    expect(await screen.findByText("Loaded")).toBeTruthy();
    expect(screen.queryByText(/Model state could not be confirmed/)).toBeNull();
  });

  it("reports when a successful request does not reach the target state", async () => {
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === "ollama_connection") return Promise.resolve("0.1.0");
      if (command === "ollama_models")
        return Promise.resolve([ollamaModel("alpha:latest")]);
      if (command === "ollama_running_models") return Promise.resolve([]);
      if (command === "ollama_load_model") return Promise.resolve();
      return Promise.resolve([]);
    });
    render(<App />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Load alpha:latest" }),
    );
    expect(
      await screen.findByText(/Model state could not be confirmed/),
    ).toBeTruthy();
  });

  it("uses refreshed state when a timed-out load actually completed", async () => {
    let runningQueries = 0;
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === "ollama_connection") return Promise.resolve("0.1.0");
      if (command === "ollama_models")
        return Promise.resolve([ollamaModel("alpha:latest")]);
      if (command === "ollama_running_models") {
        runningQueries += 1;
        return Promise.resolve(
          runningQueries === 1
            ? []
            : [{ name: "alpha:latest", sizeVram: null, expiresAt: null }],
        );
      }
      if (command === "ollama_load_model") return Promise.reject("timeout");
      return Promise.resolve([]);
    });
    render(<App />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Load alpha:latest" }),
    );
    expect(await screen.findByText("Loaded")).toBeTruthy();
    expect(screen.queryByText(/Model state could not be confirmed/)).toBeNull();
  });
});

describe("model details", () => {
  it("opens a model, switches to another, and returns to the list", async () => {
    vi.mocked(invoke).mockImplementation((command, args) => {
      if (command === "ollama_connection") return Promise.resolve("0.1.0");
      if (command === "ollama_running_models") return Promise.resolve([]);
      if (command === "ollama_models")
        return Promise.resolve([
          ollamaModel("alpha:latest"),
          ollamaModel("beta:latest"),
        ]);
      const modelName = (args as { modelName: string }).modelName;
      return Promise.resolve({
        format: "gguf",
        family: modelName.startsWith("alpha") ? "llama" : "qwen",
        parameter_size: "8B",
        quantization_level: "Q4_K_M",
      });
    });
    render(<App />);
    fireEvent.click(
      await screen.findByRole("button", { name: "alpha:latest" }),
    );
    expect(await screen.findByText("llama")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back to models" }));
    fireEvent.click(await screen.findByRole("button", { name: "beta:latest" }));
    expect(await screen.findByText("qwen")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back to models" }));
    expect(
      await screen.findByRole("button", { name: "alpha:latest" }),
    ).toBeTruthy();
  });

  it("shows available read-only model configuration", async () => {
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === "ollama_connection") return Promise.resolve("0.1.0");
      if (command === "ollama_models")
        return Promise.resolve([ollamaModel("alpha:latest")]);
      if (command === "ollama_running_models") return Promise.resolve([]);
      return Promise.resolve({
        format: "gguf",
        parameters: "temperature 0.7",
        template: "{{ .Prompt }}",
        model_info: { "general.architecture": "llama" },
      });
    });
    render(<App />);
    fireEvent.click(
      await screen.findByRole("button", { name: "alpha:latest" }),
    );
    expect(await screen.findByText("temperature 0.7")).toBeTruthy();
    expect(screen.getByText("{{ .Prompt }}")).toBeTruthy();
    expect(screen.getByText("llama")).toBeTruthy();
  });

  it("shows unavailable fields when the response omits details", async () => {
    vi.mocked(invoke).mockImplementation((command) =>
      Promise.resolve(
        command === "ollama_connection"
          ? "0.1.0"
          : command === "ollama_running_models"
            ? []
            : command === "ollama_models"
              ? [ollamaModel("alpha:latest")]
              : {},
      ),
    );
    render(<App />);
    fireEvent.click(
      await screen.findByRole("button", { name: "alpha:latest" }),
    );
    expect(await screen.findByText("Model details unavailable"));
  });

  it("shows a detail error and allows retry", async () => {
    let fail = true;
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === "ollama_connection") return Promise.resolve("0.1.0");
      if (command === "ollama_running_models") return Promise.resolve([]);
      if (command === "ollama_models")
        return Promise.resolve([ollamaModel("alpha:latest")]);
      return fail
        ? Promise.reject("unavailable")
        : Promise.resolve({ format: "gguf" });
    });
    render(<App />);
    fireEvent.click(
      await screen.findByRole("button", { name: "alpha:latest" }),
    );
    expect(
      await screen.findByText("Could not load model details"),
    ).toBeTruthy();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry details" }));
    expect(await screen.findByText("gguf")).toBeTruthy();
  });
});

describe("desktop workspace", () => {
  it("navigates every workspace without pretending deferred services are active", async () => {
    render(<App />);
    await screen.findByText("Connected");
    for (const name of [
      "Discover",
      "Running models",
      "Downloads",
      "Chat",
      "API access",
      "Settings",
      "Installed models",
    ]) {
      fireEvent.click(
        screen.getByRole("button", { name: `Navigate to ${name}` }),
      );
      expect(screen.getByRole("heading", { name, level: 1 })).toBeTruthy();
    }
    expect(
      vi
        .mocked(invoke)
        .mock.calls.every(([name]) =>
          [
            "ollama_connection",
            "ollama_models",
            "ollama_running_models",
            "ollama_catalog",
          ].includes(name),
        ),
    ).toBe(true);
  });

  it("searches installed models and keeps the list visible beside the inspector", async () => {
    vi.mocked(invoke).mockImplementation((command) =>
      Promise.resolve(
        command === "ollama_connection"
          ? "0.1.0"
          : command === "ollama_models"
            ? [ollamaModel("alpha:latest"), ollamaModel("beta:latest")]
            : command === "ollama_model_details"
              ? { format: "gguf" }
              : [],
      ),
    );
    render(<App />);
    fireEvent.click(
      await screen.findByRole("button", { name: "alpha:latest" }),
    );
    expect(await screen.findByText("gguf")).toBeTruthy();
    expect(screen.getByRole("button", { name: "beta:latest" })).toBeTruthy();
    for (const name of ["Rename model", "Duplicate model", "Delete model"]) {
      expect(
        screen.getByRole("button", { name }).hasAttribute("disabled"),
      ).toBe(true);
    }
    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search installed models" }),
      { target: { value: "BETA" } },
    );
    expect(screen.queryByRole("button", { name: "alpha:latest" })).toBeNull();
    expect(screen.getByRole("button", { name: "beta:latest" })).toBeTruthy();
  });

  it("loads live catalog results, searches remotely, and shows installed state", async () => {
    let intersectionCallback: IntersectionObserverCallback | undefined;
    let failNextPage = true;
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(callback: IntersectionObserverCallback) {
          intersectionCallback = callback;
        }

        observe() {}
        disconnect() {}
        unobserve() {}
        takeRecords() {
          return [];
        }
      },
    );
    vi.mocked(invoke).mockImplementation((command, args) =>
      Promise.resolve(
        command === "ollama_connection"
          ? "0.1.0"
          : command === "ollama_models"
            ? [ollamaModel("qwen3:8b")]
            : command === "ollama_catalog"
              ? (args as { page?: number }).page === 2 && failNextPage
                ? ((failNextPage = false), Promise.reject(new Error("network")))
                : {
                    models: [
                      {
                        name: "qwen3",
                        description: "A reasoning model family.",
                        capabilities: ["thinking", "tools"],
                        downloads: "25.8M",
                        sizes: ["8b", "14b"],
                        downloadSize: "5.2GB",
                        variants: [
                          { tag: "8b", downloadSize: "5.2GB" },
                          { tag: "14b", downloadSize: "9.3GB" },
                          { tag: "latest", downloadSize: "5.2GB" },
                        ],
                      },
                      {
                        name: "gemma4",
                        description: "An open model family.",
                        capabilities: ["vision"],
                        downloads: "2.1M",
                        sizes: [],
                        downloadSize: null,
                      },
                    ],
                    page: (args as { page?: number }).page ?? 1,
                    hasMore: true,
                  }
              : [],
      ),
    );
    render(<App />);
    fireEvent.click(
      screen.getByRole("button", { name: "Navigate to Discover" }),
    );
    expect(await screen.findByText("qwen3")).toBeTruthy();
    expect(screen.getByText("gemma4")).toBeTruthy();
    expect(screen.getByText("Installed")).toBeTruthy();
    expect(screen.getByText("25.8M")).toBeTruthy();
    expect(screen.getByText("5.2GB - 9.3GB")).toBeTruthy();
    expect(
      screen
        .getByRole("row", { name: /qwen3/ })
        .querySelector(".directory-size")?.textContent,
    ).toBe("5.2GB - 9.3GB");
    expect(
      screen
        .getByRole("row", { name: /qwen3/ })
        .querySelector(".model-size-hints")?.textContent,
    ).toBe("8b · 14b");
    expect(
      screen
        .getByRole("row", { name: /gemma4/ })
        .querySelector(".directory-size")?.textContent,
    ).toBe("-");
    expect(screen.getByRole("columnheader", { name: "Size" })).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Load more models" }),
    ).toBeNull();
    const search = screen.getByRole("searchbox", { name: "Search models" });
    fireEvent.change(search, { target: { value: "qwen" } });
    await waitFor(() => {
      expect(
        vi
          .mocked(invoke)
          .mock.calls.some(
            ([name, args]) =>
              name === "ollama_catalog" &&
              (args as { query?: string }).query === "qwen",
          ),
      ).toBe(true);
    });
    const catalogEnd = await screen.findByTestId("catalog-end");
    act(() => {
      intersectionCallback?.(
        [
          {
            isIntersecting: true,
            target: catalogEnd,
          } as unknown as IntersectionObserverEntry,
        ],
        {} as IntersectionObserver,
      );
    });
    const retryLoad = await screen.findByRole("button", {
      name: "Retry loading more",
    });
    await waitFor(() =>
      expect(
        vi
          .mocked(invoke)
          .mock.calls.some(
            ([name, args]) =>
              name === "ollama_catalog" &&
              (args as { page?: number }).page === 2,
          ),
      ).toBe(true),
    );
    fireEvent.click(retryLoad);
    await waitFor(() =>
      expect(
        vi
          .mocked(invoke)
          .mock.calls.filter(
            ([name, args]) =>
              name === "ollama_catalog" &&
              (args as { page?: number }).page === 2,
          ),
      ).toHaveLength(2),
    );
    fireEvent.click(screen.getByRole("button", { name: "Navigate to Chat" }));
    expect(
      screen
        .getByRole("button", { name: "Send message" })
        .hasAttribute("disabled"),
    ).toBe(true);
    fireEvent.click(
      screen.getByRole("button", { name: "Navigate to API access" }),
    );
    expect(
      screen
        .getByRole("button", { name: "Create API key" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(screen.getByText("Gateway not configured")).toBeTruthy();
    await screen.findByText("Connected");
  });

  it("shows a recoverable catalog error", async () => {
    let fail = true;
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === "ollama_connection") return Promise.resolve("0.1.0");
      if (command === "ollama_catalog")
        return fail
          ? Promise.reject("unavailable")
          : Promise.resolve({
              models: [],
              page: 1,
              hasMore: false,
            });
      return Promise.resolve([]);
    });
    render(<App />);
    fireEvent.click(
      screen.getByRole("button", { name: "Navigate to Discover" }),
    );
    expect(
      await screen.findByText("Could not load the Ollama catalog"),
    ).toBeTruthy();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry catalog" }));
    expect(await screen.findByText("No matching models")).toBeTruthy();
  });

  it("marks cloud catalog models as unavailable for local download", async () => {
    vi.mocked(invoke).mockImplementation((command) =>
      Promise.resolve(
        command === "ollama_connection"
          ? "0.1.0"
          : command === "ollama_catalog"
            ? {
                models: [
                  {
                    name: "deepseek-v4.1-flash",
                    description: "Cloud model.",
                    capabilities: ["vision", "tools", "thinking"],
                    downloads: null,
                    sizes: [],
                    cloud: true,
                  },
                ],
                page: 1,
                hasMore: false,
              }
            : [],
      ),
    );
    render(<App />);
    fireEvent.click(
      screen.getByRole("button", { name: "Navigate to Discover" }),
    );

    expect(await screen.findByText("Cloud only")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Download deepseek-v4.1-flash" }),
    ).toBeNull();
    expect(
      vi
        .mocked(invoke)
        .mock.calls.some(([command]) => command === "ollama_pull_model"),
    ).toBe(false);
  });

  it("pulls a selected catalog model and shows its completed download", async () => {
    vi.mocked(invoke).mockImplementation((command) =>
      Promise.resolve(
        command === "ollama_connection"
          ? "0.1.0"
          : command === "ollama_catalog"
            ? {
                models: [
                  {
                    name: "qwen3",
                    description: "Reasoning model.",
                    capabilities: ["thinking"],
                    downloads: "25.8M",
                    sizes: ["8b"],
                  },
                ],
                page: 1,
                hasMore: false,
              }
            : [],
      ),
    );
    render(<App />);
    fireEvent.click(
      screen.getByRole("button", { name: "Navigate to Discover" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Download qwen3" }),
    );
    await waitFor(() =>
      expect(
        vi
          .mocked(invoke)
          .mock.calls.some(
            ([name, args]) =>
              name === "ollama_pull_model" &&
              (args as { modelName?: string }).modelName === "qwen3:8b",
          ),
      ).toBe(true),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Navigate to Downloads" }),
    );
    expect(await screen.findByText("Download complete")).toBeTruthy();
    expect(screen.getByText("completed")).toBeTruthy();
  });

  it("offers parameter choices from the download action and pulls the selected tag", async () => {
    vi.mocked(invoke).mockImplementation((command) =>
      Promise.resolve(
        command === "ollama_connection"
          ? "0.1.0"
          : command === "ollama_catalog"
            ? {
                models: [
                  {
                    name: "qwen3",
                    description: "Reasoning model.",
                    capabilities: ["thinking"],
                    downloads: "25.8M",
                    sizes: ["4b", "8b"],
                    downloadSize: "5.2GB",
                    variants: [
                      { tag: "4b", downloadSize: "1GB - 2GB" },
                      { tag: "8b", downloadSize: "5GB - 6GB" },
                      { tag: "latest", downloadSize: "1GB - 2GB" },
                    ],
                  },
                ],
                page: 1,
                hasMore: false,
              }
            : [],
      ),
    );
    render(<App />);
    fireEvent.click(
      screen.getByRole("button", { name: "Navigate to Discover" }),
    );

    const download = await screen.findByRole("button", {
      name: "Download qwen3",
    });
    expect(screen.queryByRole("combobox", { name: /qwen3/ })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "4b · 2.5GB - 3GB" }),
    ).toBeNull();
    fireEvent.click(download);
    const variantChoice = await screen.findByRole("button", {
      name: "4b · 1GB - 2GB",
    });
    fireEvent.click(variantChoice);
    expect(
      screen
        .getByRole("row", { name: /qwen3/ })
        .querySelector(".directory-size")?.textContent,
    ).toBe("1GB - 6GB");

    await waitFor(() =>
      expect(
        vi
          .mocked(invoke)
          .mock.calls.some(
            ([name, args]) =>
              name === "ollama_pull_model" &&
              (args as { modelName?: string }).modelName === "qwen3:4b",
          ),
      ).toBe(true),
    );
  });

  it("shows the smallest-to-largest catalog size across parameters and tags", async () => {
    vi.mocked(invoke).mockImplementation((command) =>
      Promise.resolve(
        command === "ollama_connection"
          ? "0.1.0"
          : command === "ollama_catalog"
            ? {
                models: [
                  {
                    name: "range-model",
                    description: "A model with multiple parameter sizes.",
                    capabilities: ["chat"],
                    downloads: "10K",
                    sizes: ["5b", "6b"],
                    downloadSize: "1GB - 2GB",
                    variants: [
                      { tag: "5b", downloadSize: "1GB - 2GB" },
                      { tag: "5b-q4_K_M", downloadSize: "1.5GB" },
                      { tag: "6b", downloadSize: "5GB - 6GB" },
                      { tag: "6b-q4_K_M", downloadSize: "5.4GB" },
                      { tag: "latest", downloadSize: "1GB - 2GB" },
                    ],
                  },
                ],
                page: 1,
                hasMore: false,
              }
            : [],
      ),
    );
    render(<App />);
    fireEvent.click(
      screen.getByRole("button", { name: "Navigate to Discover" }),
    );

    expect(
      await screen.findByRole("row", { name: /range-model/ }),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("row", { name: /range-model/ })
        .querySelector(".directory-size")?.textContent,
    ).toBe("1GB - 6GB");
  });

  it("offers exact quantization tags and sizes after choosing a parameter size", async () => {
    vi.mocked(invoke).mockImplementation((command) =>
      Promise.resolve(
        command === "ollama_connection"
          ? "0.1.0"
          : command === "ollama_catalog"
            ? {
                models: [
                  {
                    name: "tev1",
                    description: "Decision model.",
                    capabilities: ["reasoning"],
                    downloads: "170K",
                    sizes: ["0.8b", "4b"],
                    downloadSize: "4.4GB - 4.6GB",
                    variants: [
                      { tag: "0.8b", downloadSize: "834MB - 1.5GB" },
                      { tag: "0.8b-q8_0", downloadSize: "834MB" },
                      { tag: "4b", downloadSize: "4.4GB - 4.6GB" },
                      { tag: "4b-q4_K_M", downloadSize: "2.8GB" },
                      { tag: "4b-q8_0", downloadSize: "4.6GB" },
                      { tag: "4b-bf16", downloadSize: "8.7GB" },
                    ],
                  },
                ],
                page: 1,
                hasMore: false,
              }
            : [],
      ),
    );
    render(<App />);
    fireEvent.click(
      screen.getByRole("button", { name: "Navigate to Discover" }),
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Download tev1" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "4b · 4.4GB - 4.6GB" }),
    );

    expect(
      await screen.findByRole("button", {
        name: /tev1:4b-q4_K_M.*2.8GB.*Recommended/,
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole("row", { name: /tev1/ }).querySelector(".directory-size")
        ?.textContent,
    ).toBe("834MB - 8.7GB");
    expect(
      screen.getByRole("button", { name: /tev1:4b-q8_0.*4.6GB/ }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /tev1:4b-bf16.*8.7GB/ }),
    ).toBeTruthy();
    expect(
      vi
        .mocked(invoke)
        .mock.calls.some(([command]) => command === "ollama_pull_model"),
    ).toBe(false);

    fireEvent.click(
      screen.getByRole("button", {
        name: /tev1:4b-q4_K_M.*2.8GB.*Recommended/,
      }),
    );
    await waitFor(() =>
      expect(
        vi
          .mocked(invoke)
          .mock.calls.some(
            ([command, args]) =>
              command === "ollama_pull_model" &&
              (args as { modelName?: string }).modelName === "tev1:4b-q4_K_M",
          ),
      ).toBe(true),
    );
  });

  it("recommends the default available quantization when Q4_K_M is unavailable", async () => {
    vi.mocked(invoke).mockImplementation((command) =>
      Promise.resolve(
        command === "ollama_connection"
          ? "0.1.0"
          : command === "ollama_catalog"
            ? {
                models: [
                  {
                    name: "sample-model",
                    description: "A test model.",
                    capabilities: ["chat"],
                    downloads: "10K",
                    sizes: ["4b"],
                    variants: [
                      { tag: "4b-q5_K_M", downloadSize: "3.1GB" },
                      { tag: "4b-q8_0", downloadSize: "4.6GB" },
                    ],
                  },
                ],
                page: 1,
                hasMore: false,
              }
            : [],
      ),
    );
    render(<App />);
    fireEvent.click(
      screen.getByRole("button", { name: "Navigate to Discover" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Download sample-model" }),
    );

    const recommended = await screen.findByRole("button", {
      name: /sample-model:4b-q5_K_M.*3.1GB.*Recommended/,
    });
    expect(recommended.classList.contains("recommended")).toBe(true);
    expect(
      screen.getByRole("button", { name: /sample-model:4b-q8_0.*4.6GB/ }),
    ).toBeTruthy();
    expect(
      vi
        .mocked(invoke)
        .mock.calls.some(([command]) => command === "ollama_pull_model"),
    ).toBe(false);
  });

  it("shows download progress only on the model being pulled", async () => {
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === "ollama_connection") return Promise.resolve("0.1.0");
      if (command === "ollama_catalog")
        return Promise.resolve({
          models: [
            {
              name: "qwen3",
              description: "Reasoning model.",
              capabilities: ["thinking"],
              downloads: "25.8M",
              sizes: ["8b"],
            },
            {
              name: "llama3.2",
              description: "Everyday chat model.",
              capabilities: ["chat"],
              downloads: "12M",
              sizes: ["3b"],
            },
          ],
          page: 1,
          hasMore: false,
        });
      if (command === "ollama_pull_model") return new Promise(() => {});
      return Promise.resolve([]);
    });
    render(<App />);
    fireEvent.click(
      screen.getByRole("button", { name: "Navigate to Discover" }),
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Download qwen3" }),
    );

    const qwenPause = await screen.findByRole("button", {
      name: "Pause qwen3",
    });
    const qwenCancel = screen.getByRole("button", {
      name: "Cancel download qwen3",
    });
    const llamaDownload = screen.getByRole("button", {
      name: "Download llama3.2",
    });
    expect(qwenPause.hasAttribute("disabled")).toBe(false);
    expect(qwenCancel.hasAttribute("disabled")).toBe(false);
    expect(llamaDownload.hasAttribute("disabled")).toBe(false);
    expect(screen.getByText("Downloading")).toBeTruthy();
    expect(
      screen.getByRole("progressbar", { name: "Downloading qwen3" }),
    ).toBeTruthy();

    fireEvent.click(llamaDownload);

    expect(
      await screen.findByRole("button", { name: "Cancel download llama3.2" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Pause llama3.2" })).toBeNull();
    expect(screen.getByText("Queued")).toBeTruthy();
  });

  it("keeps a failed model download visible in the catalog row", async () => {
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === "ollama_connection") return Promise.resolve("0.1.0");
      if (command === "ollama_catalog")
        return Promise.resolve({
          models: [
            {
              name: "qwen3",
              description: "Reasoning model.",
              capabilities: ["thinking"],
              downloads: "25.8M",
              sizes: ["8b"],
            },
          ],
          page: 1,
          hasMore: false,
        });
      if (command === "ollama_pull_model") return Promise.reject("unavailable");
      return Promise.resolve([]);
    });
    render(<App />);
    fireEvent.click(
      screen.getByRole("button", { name: "Navigate to Discover" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Download qwen3" }),
    );

    expect(await screen.findByText("Download failed")).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "Download qwen3" })
        .hasAttribute("disabled"),
    ).toBe(false);
  });

  it("shows the Ollama failure reason in the download queue", async () => {
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === "ollama_connection") return Promise.resolve("0.1.0");
      if (command === "ollama_catalog")
        return Promise.resolve({
          models: [
            {
              name: "qwen3",
              description: "Reasoning model.",
              capabilities: ["thinking"],
              downloads: "25.8M",
              sizes: ["8b"],
            },
          ],
          page: 1,
          hasMore: false,
        });
      if (command === "ollama_pull_model")
        return Promise.reject("model not found: qwen3");
      return Promise.resolve([]);
    });
    render(<App />);
    fireEvent.click(
      screen.getByRole("button", { name: "Navigate to Discover" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Download qwen3" }),
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Navigate to Downloads" }),
    );
    expect(await screen.findByText(/model not found: qwen3/)).toBeTruthy();
  });

  it("pauses and resumes a model download", async () => {
    let pullCount = 0;
    let rejectPull: ((reason?: string) => void) | undefined;
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === "ollama_connection") return Promise.resolve("0.1.0");
      if (command === "ollama_catalog")
        return Promise.resolve({
          models: [
            {
              name: "qwen3",
              description: "Reasoning model.",
              capabilities: ["thinking"],
              downloads: "25.8M",
              sizes: ["8b"],
            },
          ],
          page: 1,
          hasMore: false,
        });
      if (command === "ollama_pull_model") {
        pullCount += 1;
        return new Promise((_, reject) => {
          rejectPull = reject;
        });
      }
      if (command === "ollama_cancel_pull") {
        rejectPull?.("Download cancelled");
        return Promise.resolve();
      }
      return Promise.resolve([]);
    });
    render(<App />);
    fireEvent.click(
      screen.getByRole("button", { name: "Navigate to Discover" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Download qwen3" }),
    );

    fireEvent.click(await screen.findByRole("button", { name: "Pause qwen3" }));
    expect(await screen.findByText("Download paused")).toBeTruthy();
    expect(
      vi
        .mocked(invoke)
        .mock.calls.some(([command]) => command === "ollama_cancel_pull"),
    ).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Resume qwen3" }));
    await waitFor(() => expect(pullCount).toBe(2));
    expect(screen.getByText("Downloading")).toBeTruthy();
  });

  it("cancels and removes a model download task", async () => {
    let rejectPull: ((reason?: string) => void) | undefined;
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === "ollama_connection") return Promise.resolve("0.1.0");
      if (command === "ollama_catalog")
        return Promise.resolve({
          models: [
            {
              name: "qwen3",
              description: "Reasoning model.",
              capabilities: ["thinking"],
              downloads: "25.8M",
              sizes: ["8b"],
            },
          ],
          page: 1,
          hasMore: false,
        });
      if (command === "ollama_pull_model")
        return new Promise((_, reject) => {
          rejectPull = reject;
        });
      if (command === "ollama_cancel_pull") {
        rejectPull?.("Download cancelled");
        return Promise.resolve();
      }
      return Promise.resolve([]);
    });
    render(<App />);
    fireEvent.click(
      screen.getByRole("button", { name: "Navigate to Discover" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Download qwen3" }),
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Cancel download qwen3" }),
    );
    expect(
      await screen.findByRole("button", { name: "Download qwen3" }),
    ).toBeTruthy();
  });

  it("renders streamed Ollama pull progress in Downloads", async () => {
    let reportProgress:
      | ((payload: {
          model: string;
          status: "downloading" | "complete";
          message: string;
          completed: number | null;
          total: number | null;
        }) => void)
      | undefined;
    vi.mocked(listen).mockImplementation((_event, handler) => {
      reportProgress = (payload) =>
        (handler as (event: { payload: typeof payload }) => void)({ payload });
      return Promise.resolve(() => {});
    });
    vi.mocked(invoke).mockImplementation((command) =>
      Promise.resolve(
        command === "ollama_connection"
          ? "0.1.0"
          : command === "ollama_catalog"
            ? {
                models: [
                  {
                    name: "qwen3",
                    description: "Reasoning model.",
                    capabilities: ["thinking"],
                    downloads: "25.8M",
                    sizes: ["8b"],
                  },
                ],
                page: 1,
                hasMore: false,
              }
            : [],
      ),
    );
    render(<App />);
    await waitFor(() => expect(reportProgress).toBeTypeOf("function"));
    fireEvent.click(
      screen.getByRole("button", { name: "Navigate to Discover" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Download qwen3" }),
    );
    await waitFor(() =>
      expect(
        vi
          .mocked(invoke)
          .mock.calls.some(([command]) => command === "ollama_pull_model"),
      ).toBe(true),
    );
    await waitFor(() => expect(reportProgress).toBeTypeOf("function"));
    act(() =>
      reportProgress?.({
        model: "qwen3:8b",
        status: "downloading",
        message: "pulling model layers",
        completed: 3,
        total: 10,
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Navigate to Downloads" }),
    );
    expect(await screen.findByText("3 B / 10 B")).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe(
      "30",
    );
  });

  it("summarizes actual local model counts in the sidebar", async () => {
    vi.mocked(invoke).mockImplementation((command) =>
      Promise.resolve(
        command === "ollama_connection"
          ? "0.1.0"
          : command === "ollama_models"
            ? [ollamaModel("alpha:latest"), ollamaModel("beta:latest")]
            : command === "ollama_running_models"
              ? [{ name: "alpha:latest", sizeVram: null, expiresAt: null }]
              : [],
      ),
    );
    render(<App />);
    const service = screen.getByRole("region", { name: "Local Ollama" });
    await waitFor(() => {
      expect(
        within(service).getByLabelText("Installed models").textContent,
      ).toBe("2");
      expect(within(service).getByLabelText("Running models").textContent).toBe(
        "1",
      );
    });
    expect(within(service).getByText("Service available")).toBeTruthy();
  });

  it("keeps unknown and failed sidebar counts distinct from zero", async () => {
    let rejectModels: (reason: Error) => void = () => {};
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === "ollama_connection") return Promise.resolve("0.1.0");
      if (command === "ollama_models")
        return new Promise((_resolve, reject) => {
          rejectModels = reject;
        });
      return Promise.resolve([]);
    });
    render(<App />);
    const service = screen.getByRole("region", { name: "Local Ollama" });
    expect(within(service).getByLabelText("Installed models").textContent).toBe(
      "Loading",
    );
    await screen.findByText("Connected");
    rejectModels(new Error("unavailable"));
    await waitFor(() => {
      expect(
        within(service).getByLabelText("Installed models").textContent,
      ).toBe("Unavailable");
      expect(within(service).getByLabelText("Running models").textContent).toBe(
        "0",
      );
    });
  });
});

describe("language and application version settings", () => {
  it("switches all application UI to Chinese and persists the preference", async () => {
    const { unmount } = render(<App />);
    await screen.findByText("Connected");
    fireEvent.click(screen.getByRole("button", { name: "Open settings" }));
    fireEvent.click(screen.getByRole("combobox", { name: "Language" }));
    fireEvent.click(screen.getByRole("option", { name: "简体中文" }));

    expect(
      screen.getByRole("heading", { name: "设置", level: 1 }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "导航到发现模型" })).toBeTruthy();
    expect(screen.getByText("已连接")).toBeTruthy();
    expect(screen.getByText("应用版本")).toBeTruthy();
    expect(screen.getAllByText("0.1.0")).toHaveLength(2);
    expect(localStorage.getItem("lokvyn.locale")).toBe("zh-CN");

    for (const [label, heading] of [
      ["发现模型", "发现模型"],
      ["已安装模型", "已安装模型"],
      ["运行中的模型", "运行中的模型"],
      ["下载", "下载"],
      ["对话", "对话"],
      ["API 访问", "API 访问"],
      ["设置", "设置"],
    ]) {
      fireEvent.click(screen.getByRole("button", { name: `导航到${label}` }));
      expect(
        screen.getByRole("heading", { name: heading, level: 1 }),
      ).toBeTruthy();
    }

    unmount();
    render(<App />);
    expect(
      await screen.findByRole("heading", { name: "已安装模型", level: 1 }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "导航到设置" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "导航到设置" }));
    fireEvent.click(screen.getByRole("combobox", { name: "语言" }));
    fireEvent.click(screen.getByRole("option", { name: "English" }));
    expect(
      screen.getByRole("heading", { name: "Settings", level: 1 }),
    ).toBeTruthy();
    expect(localStorage.getItem("lokvyn.locale")).toBe("en");
    expect(document.documentElement.lang).toBe("en");
  });

  it("localizes model dates and labels while preserving Ollama content", async () => {
    localStorage.setItem("lokvyn.locale", "zh-CN");
    vi.mocked(invoke).mockImplementation((command) =>
      Promise.resolve(
        command === "ollama_connection"
          ? "0.2.0"
          : command === "ollama_models"
            ? [
                {
                  name: "Chat:latest",
                  size: 512,
                  modifiedAt: "2025-01-02T03:04:05Z",
                },
              ]
            : command === "ollama_model_details"
              ? {
                  format: "gguf",
                  parameters: "temperature 0.7",
                  system: "Chat",
                  model_info: {},
                }
              : [],
      ),
    );
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Chat:latest" }));
    expect(screen.getByText("512 字节")).toBeTruthy();
    expect(
      screen.getByText(
        new Intl.DateTimeFormat("zh-CN", {
          dateStyle: "medium",
          timeStyle: "short",
        }).format(new Date("2025-01-02T03:04:05Z")),
      ),
    ).toBeTruthy();
    expect(await screen.findByText("temperature 0.7")).toBeTruthy();
    expect(screen.getByText("Chat")).toBeTruthy();
    expect(screen.getByRole("button", { name: "重命名模型" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "复制模型" })).toBeTruthy();
    expect(document.documentElement.lang).toBe("zh-CN");
  });

  it("keeps catalog filters working with translated options", async () => {
    localStorage.setItem("lokvyn.locale", "zh-CN");
    vi.mocked(invoke).mockImplementation((command, args) =>
      Promise.resolve(
        command === "ollama_connection"
          ? "0.1.0"
          : command === "ollama_catalog"
            ? {
                models: [
                  {
                    name: "qwen3",
                    description: "推理与多语言对话。",
                    capabilities: ["thinking"],
                    downloads: "25.8M",
                    sizes: ["8b"],
                  },
                  {
                    name: "nomic-embed-text",
                    description: "用于搜索与检索的文本向量。",
                    capabilities: ["embedding"],
                    downloads: "2.1M",
                    sizes: ["latest"],
                  },
                ].filter((model) =>
                  (args as { capability?: string }).capability === "embedding"
                    ? model.name === "nomic-embed-text"
                    : true,
                ),
                page: 1,
                hasMore: false,
              }
            : [],
      ),
    );
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "导航到发现模型" }));
    expect(screen.getByRole("table", { name: "模型目录" })).toBeTruthy();
    expect(await screen.findByText("qwen3")).toBeTruthy();
    expect(screen.getByText("nomic-embed-text")).toBeTruthy();
    fireEvent.click(screen.getByRole("combobox", { name: "能力类型" }));
    fireEvent.click(screen.getByRole("option", { name: "向量嵌入" }));
    await waitFor(() => expect(screen.queryByText("qwen3")).toBeNull());
    expect(screen.getByText("nomic-embed-text")).toBeTruthy();
    expect(screen.getByText("用于搜索与检索的文本向量。")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "下载 nomic-embed-text" }),
    ).toBeTruthy();
    await screen.findByText("已连接");
  });

  it("falls back to English for an unsupported saved locale", async () => {
    localStorage.setItem("lokvyn.locale", "fr");
    render(<App />);
    expect(await screen.findByText("Connected")).toBeTruthy();
    expect(document.documentElement.lang).toBe("en");
  });

  it("shows a localized fallback when the runtime version is unavailable", async () => {
    localStorage.setItem("lokvyn.locale", "zh-CN");
    vi.mocked(getVersion).mockRejectedValue(new Error("unavailable"));
    render(<App />);
    await screen.findByText("已连接");
    fireEvent.click(screen.getByRole("button", { name: "导航到设置" }));
    expect(screen.getAllByText("版本信息不可用")).toHaveLength(2);
    expect(screen.getByRole("combobox", { name: "语言" })).toBeTruthy();
  });

  it("shows the Tauri runtime version in the footer and Settings", async () => {
    vi.mocked(getVersion).mockResolvedValue("1.2.3");
    render(<App />);
    expect(await screen.findByText("1.2.3")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open settings" }));
    expect(await screen.findAllByText("1.2.3")).toHaveLength(2);
  });
});
