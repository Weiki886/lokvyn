import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import App from "./App";

describe("application shell", () => {
  it("identifies the application and its current stage", () => {
    render(<App />);
    expect(screen.getByRole("heading", { name: "Lokvyn" })).toBeTruthy();
    expect(
      screen.getByText(/Ollama integration is not available yet/i),
    ).toBeTruthy();
  });
});
