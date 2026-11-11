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
      Promise.resolve(command === "ollama_connection" ? "0.1.0" : models),
    );
    render(<App />);
    expect(
      await screen.findByRole("button", { name: /alpha:latest/ }),
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
      await screen.findByRole("button", { name: /beta:latest/ }),
    ).toBeTruthy();
    expect(screen.queryByText("alpha:latest")).toBeNull();
  });

  it("keeps models visible when optional metadata is missing or invalid", async () => {
    vi.mocked(invoke).mockImplementation((command) =>
      Promise.resolve(
        command === "ollama_connection"
          ? "0.1.0"
          : [{ name: "alpha:latest", size: null, modifiedAt: "invalid" }],
      ),
    );
    render(<App />);
    expect(
      await screen.findByRole("button", { name: /alpha:latest/ }),
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
});

describe("model details", () => {
  it("opens a model, switches to another, and returns to the list", async () => {
    vi.mocked(invoke).mockImplementation((command, args) => {
      if (command === "ollama_connection") return Promise.resolve("0.1.0");
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

  it("shows unavailable fields when the response omits details", async () => {
    vi.mocked(invoke).mockImplementation((command) =>
      Promise.resolve(
        command === "ollama_connection"
          ? "0.1.0"
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
