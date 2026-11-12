import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Select } from "./FormControls";

afterEach(cleanup);

const options = [
  { value: "all", label: "All capabilities" },
  { value: "chat", label: "Chat" },
  { value: "code", label: "Code" },
  { value: "embedding", label: "Embedding" },
];

function Filter() {
  const [value, setValue] = useState("all");
  return (
    <>
      <Select
        label="Capability"
        value={value}
        options={options}
        onChange={setValue}
      />
      <button>Next field</button>
      <output>{value}</output>
    </>
  );
}

describe("application select", () => {
  it("renders an application listbox and commits a pointer selection", () => {
    render(<Filter />);
    const trigger = screen.getByRole("combobox", { name: "Capability" });
    expect(trigger.tagName).toBe("BUTTON");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(trigger);
    const list = screen.getByRole("listbox", { name: "Capability" });
    expect(trigger.getAttribute("aria-controls")).toBe(list.id);
    expect(
      screen
        .getByRole("option", { name: "All capabilities" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    fireEvent.click(screen.getByRole("option", { name: "Code" }));
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(trigger.textContent).toBe("Code");
    expect(screen.getByRole("status").textContent).toBe("code");
    expect(document.activeElement).toBe(trigger);
  });

  it("navigates by arrows and Home/End, committing only with Enter or Space", () => {
    render(<Filter />);
    const trigger = screen.getByRole("combobox");
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyDown(trigger, { key: "End" });
    expect(trigger.getAttribute("aria-activedescendant")).toBe(
      screen.getByRole("option", { name: "Embedding" }).id,
    );
    expect(screen.getByRole("status").textContent).toBe("all");
    fireEvent.keyDown(trigger, { key: "Home" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyDown(trigger, { key: " " });
    expect(trigger.textContent).toBe("Chat");
    fireEvent.keyDown(trigger, { key: "ArrowUp" });
    fireEvent.keyDown(trigger, { key: "End" });
    fireEvent.keyDown(trigger, { key: "ArrowUp" });
    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(trigger.textContent).toBe("Code");
    expect(document.activeElement).toBe(trigger);
  });

  it("supports typeahead and repeated letters without changing the value until commit", () => {
    render(<Filter />);
    const trigger = screen.getByRole("combobox");
    fireEvent.keyDown(trigger, { key: "c" });
    expect(trigger.getAttribute("aria-activedescendant")).toBe(
      screen.getByRole("option", { name: "Chat" }).id,
    );
    fireEvent.keyDown(trigger, { key: "c" });
    expect(trigger.getAttribute("aria-activedescendant")).toBe(
      screen.getByRole("option", { name: "Code" }).id,
    );
    fireEvent.keyDown(trigger, { key: "o" });
    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(trigger.textContent).toBe("Code");
  });

  it("cancels with Escape or outside pointer, and closes on Tab without trapping focus", () => {
    render(<Filter />);
    const trigger = screen.getByRole("combobox");
    fireEvent.click(trigger);
    fireEvent.keyDown(trigger, { key: "End" });
    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(trigger.textContent).toBe("All capabilities");
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.click(trigger);
    fireEvent.pointerDown(screen.getByRole("button", { name: "Next field" }));
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.click(trigger);
    expect(fireEvent.keyDown(trigger, { key: "Tab" })).toBe(true);
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.click(trigger);
    act(() => screen.getByRole("button", { name: "Next field" }).focus());
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("uses translated labels and emits the stable option value once", () => {
    const onChange = vi.fn();
    render(
      <Select
        label="能力类型"
        value="all"
        onChange={onChange}
        options={[
          { value: "all", label: "全部能力" },
          { value: "embedding", label: "向量嵌入" },
        ]}
      />,
    );
    const trigger = screen.getByRole("combobox", { name: "能力类型" });
    fireEvent.keyDown(trigger, { key: "向" });
    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(onChange).toHaveBeenCalledExactlyOnceWith("embedding");
  });

  it("does not open disabled or empty controls", () => {
    render(
      <>
        <Select
          label="Disabled"
          value="all"
          options={options}
          onChange={vi.fn()}
          disabled
        />
        <Select label="Empty" value="" options={[]} onChange={vi.fn()} />
      </>,
    );
    for (const trigger of screen.getAllByRole("combobox")) {
      expect(trigger.hasAttribute("disabled")).toBe(true);
      fireEvent.click(trigger);
      fireEvent.keyDown(trigger, { key: "ArrowDown" });
    }
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("never commits an option removed while the menu is open", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <Select
        label="Model"
        value="all"
        options={options}
        onChange={onChange}
      />,
    );
    const trigger = screen.getByRole("combobox");
    fireEvent.click(trigger);
    fireEvent.keyDown(trigger, { key: "End" });
    rerender(
      <Select
        label="Model"
        value="all"
        options={options.slice(0, 1)}
        onChange={onChange}
      />,
    );
    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("stays closed after an open control is disabled and enabled again", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <Select
        label="Model"
        value="all"
        options={options}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole("combobox"));
    expect(screen.queryByRole("listbox")).not.toBeNull();
    rerender(
      <Select
        label="Model"
        value="all"
        options={options}
        onChange={onChange}
        disabled
      />,
    );
    expect(screen.queryByRole("listbox")).toBeNull();
    rerender(
      <Select
        label="Model"
        value="all"
        options={options}
        onChange={onChange}
      />,
    );
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });
});
