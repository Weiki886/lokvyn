import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type TextareaHTMLAttributes,
} from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";
import "./form-controls.css";

export function TextInput({
  className = "",
  ...props
}: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`form-input ${className}`} />;
}

export function TextArea({
  className = "",
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea {...props} className={`form-input form-textarea ${className}`} />
  );
}

type Option = { value: string; label: string };

export function Select({
  label,
  value,
  options,
  onChange,
  disabled = false,
}: {
  label: string;
  value: string;
  options: Option[];
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const typed = useRef({ text: "", time: 0 });
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(value);
  const blocked = disabled || options.length === 0;
  if (blocked && open) setOpen(false);
  const expanded = open && !blocked;
  const selected = options.find((option) => option.value === value);
  const activeIndex = options.findIndex((option) => option.value === active);
  const optionId = (index: number) => `${id}-option-${index}`;

  function show() {
    if (blocked) return;
    setActive(selected?.value ?? options[0].value);
    typed.current = { text: "", time: 0 };
    setOpen(true);
    trigger.current?.focus();
  }

  function commit(next: string) {
    if (next !== value) onChange(next);
    setOpen(false);
    trigger.current?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (
      blocked ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.nativeEvent.isComposing
    )
      return;
    const { key } = event;
    if (key === "Tab" || key === "Escape") {
      if (key === "Escape" && expanded) event.preventDefault();
      setOpen(false);
      return;
    }
    if (["ArrowDown", "ArrowUp", "Home", "End", "Enter", " "].includes(key)) {
      event.preventDefault();
      if (!expanded) {
        show();
        if (key === "Home") setActive(options[0].value);
        if (key === "End") setActive(options[options.length - 1].value);
        return;
      }
      if (key === "Enter" || key === " ") {
        if (activeIndex !== -1) commit(options[activeIndex].value);
        else setOpen(false);
      } else {
        const next =
          key === "Home"
            ? 0
            : key === "End"
              ? options.length - 1
              : (activeIndex +
                  (key === "ArrowDown" ? 1 : -1) +
                  options.length) %
                options.length;
        setActive(options[next].value);
        typed.current = { text: "", time: 0 };
      }
      return;
    }
    if (key.length !== 1) return;
    event.preventDefault();
    const now = Date.now();
    const letter = key.toLocaleLowerCase();
    const previous = now - typed.current.time < 700 ? typed.current.text : "";
    const text = previous === letter ? letter : previous + letter;
    if (!expanded) show();
    typed.current = { text, time: now };
    const start = expanded
      ? activeIndex
      : options.findIndex((option) => option.value === value);
    for (
      let offset = text.length === 1 ? 1 : 0;
      offset < options.length + (text.length === 1 ? 1 : 0);
      offset++
    ) {
      const index = (Math.max(start, 0) + offset) % options.length;
      if (options[index].label.toLocaleLowerCase().startsWith(text)) {
        setActive(options[index].value);
        break;
      }
    }
  }

  useEffect(() => {
    if (!expanded) return;
    function dismiss(event: Event) {
      const target = event.target as Node;
      if (!trigger.current?.contains(target) && !menu.current?.contains(target))
        setOpen(false);
    }
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("focusin", dismiss);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("focusin", dismiss);
    };
  }, [expanded]);

  useLayoutEffect(() => {
    if (!expanded) return;
    // A portal keeps menus clear of the workspace's scrolling and clipping areas.
    function position() {
      if (!trigger.current || !menu.current) return;
      const rect = trigger.current.getBoundingClientRect();
      const width = Math.min(Math.max(rect.width, 200), window.innerWidth - 16);
      const below = window.innerHeight - rect.bottom - 12;
      const above = rect.top - 12;
      const upward = below < 200 && above > below;
      const maxHeight = Math.max(0, Math.min(280, upward ? above : below));
      Object.assign(menu.current.style, {
        width: `${width}px`,
        maxHeight: `${maxHeight}px`,
        left: `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`,
      });
      const height = Math.min(menu.current.scrollHeight + 2, maxHeight);
      menu.current.style.top = `${upward ? rect.top - height - 6 : rect.bottom + 6}px`;
    }
    position();
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => {
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
    };
  }, [expanded, options]);

  useEffect(() => {
    if (expanded && activeIndex !== -1)
      menu.current?.children[activeIndex]?.scrollIntoView?.({
        block: "nearest",
      });
  }, [expanded, activeIndex]);

  return (
    <>
      <button
        ref={trigger}
        type="button"
        role="combobox"
        className="form-select"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={expanded}
        aria-controls={expanded ? `${id}-listbox` : undefined}
        aria-activedescendant={
          expanded && activeIndex !== -1 ? optionId(activeIndex) : undefined
        }
        disabled={blocked}
        onClick={() => (expanded ? setOpen(false) : show())}
        onKeyDown={onKeyDown}
        title={selected?.label}
      >
        <span>{selected?.label ?? label}</span>
        <ChevronDown size={15} aria-hidden="true" />
      </button>
      {expanded &&
        createPortal(
          <div
            ref={menu}
            id={`${id}-listbox`}
            className="select-menu"
            role="listbox"
            aria-label={label}
          >
            {options.map((option, index) => (
              <div
                key={option.value}
                id={optionId(index)}
                role="option"
                aria-selected={option.value === value}
                className={`select-option ${option.value === active ? "active" : ""}`}
                onPointerMove={() => setActive(option.value)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => commit(option.value)}
              >
                <span>{option.label}</span>
                {option.value === value && (
                  <Check size={15} aria-hidden="true" />
                )}
              </div>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
