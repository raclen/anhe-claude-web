import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import clsx from "clsx";
import { CheckIcon } from "../../components/icons.tsx";
import styles from "./ThinkingPicker.module.css";

export interface ThinkingOption {
  id: string;
  label: string;
  hint: string;
}

export const THINKING_OPTIONS: ThinkingOption[] = [
  { id: "auto", label: "Auto", hint: "Model default budget" },
  { id: "off", label: "Off", hint: "No reasoning (0 tokens)" },
  { id: "low", label: "Low", hint: "1,024 token budget" },
  { id: "medium", label: "Medium", hint: "4,096 token budget" },
  { id: "high", label: "High", hint: "8,192 token budget" },
  { id: "xhigh", label: "Extra high", hint: "16,384 token budget" },
  { id: "max", label: "Max", hint: "32,768 token budget" },
];

export interface ThinkingPickerProps {
  level: string;
  disabled?: boolean;
  onChange(level: string): void;
}

export function ThinkingPicker({ level, disabled = false, onChange }: ThinkingPickerProps) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const rootRef = useRef<HTMLSpanElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const currentOption =
    THINKING_OPTIONS.find((opt) => opt.id === level) ??
    THINKING_OPTIONS.find((opt) => opt.id === "auto")!;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      const root = rootRef.current;
      if (root !== null && event.target instanceof Node && root.contains(event.target)) return;
      setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown, { capture: true });
    return () => window.removeEventListener("pointerdown", onPointerDown, { capture: true });
  }, [open]);

  useEffect(() => {
    if (open) {
      const idx = THINKING_OPTIONS.findIndex((opt) => opt.id === level);
      setHighlight(idx >= 0 ? idx : 0);
    }
  }, [open, level]);

  const onButtonKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (disabled) return;
    if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setOpen(true);
    }
  };

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      buttonRef.current?.focus();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlight((idx) => (idx + 1) % THINKING_OPTIONS.length);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlight((idx) => (idx - 1 + THINKING_OPTIONS.length) % THINKING_OPTIONS.length);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const chosen = THINKING_OPTIONS[highlight];
      if (chosen) {
        onChange(chosen.id);
        setOpen(false);
        buttonRef.current?.focus();
      }
    }
  };

  return (
    <span ref={rootRef} className={styles.anchor}>
      <button
        ref={buttonRef}
        type="button"
        className={styles.trigger}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Thinking: ${currentOption.label}`}
        title={`Thinking: ${currentOption.label}`}
        onClick={() => {
          if (!disabled) setOpen((prev) => !prev);
        }}
        onKeyDown={onButtonKeyDown}
      >
        <span className={styles.triggerLabel}>{currentOption.label}</span>
      </button>

      {open ? (
        <div
          ref={listRef}
          role="listbox"
          tabIndex={-1}
          className={styles.menu}
          onKeyDown={onMenuKeyDown}
        >
          <div className={styles.header}>Thinking</div>
          <div className={styles.viewport}>
            {THINKING_OPTIONS.map((opt, idx) => {
              const active = opt.id === level;
              const isHighlighted = idx === highlight;
              return (
                <button
                  key={opt.id}
                  type="button"
                  role="option"
                  aria-selected={active}
                  data-highlighted={isHighlighted ? "true" : undefined}
                  className={clsx(styles.item, active && styles.itemActive)}
                  onMouseEnter={() => setHighlight(idx)}
                  onClick={() => {
                    onChange(opt.id);
                    setOpen(false);
                    buttonRef.current?.focus();
                  }}
                >
                  <div className={styles.itemText}>
                    <span className={styles.itemLabel}>{opt.label}</span>
                    <span className={styles.itemHint}>{opt.hint}</span>
                  </div>
                  {active ? <CheckIcon className={styles.check} /> : null}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </span>
  );
}
