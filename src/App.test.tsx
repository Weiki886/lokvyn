import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import App from "./App";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const ollamaModel = (name: string) => ({
  name,
  size: null,
  modifiedAt: null,
});
beforeEach(() => {
  vi.mocked(invoke).mockImplementation((command) =>
    Promise.resolve(command === "ollama_connection" ? "0.1.0" : []),
  );
});
afterEach(() => {
  cleanup();
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
        new Intl.DateTimeFormat(undefined, {
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
