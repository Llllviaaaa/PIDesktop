import { useEffect, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ArrowRight, Check, CircleHelp, ShieldCheck, X } from "lucide-react";
import type { ExtensionUIRequest } from "../types";

export function ExtensionDialog({
  request,
  onAnswer,
}: {
  request: ExtensionUIRequest;
  onAnswer: (response: { value?: string; confirmed?: boolean; cancelled?: true }) => void;
}) {
  const [value, setValue] = useState("");
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    setValue(request.method === "editor" ? request.prefill ?? "" : "");
    setSelected(null);
  }, [request]);

  if (request.method === "notify" || request.method === "setStatus" || request.method === "setWidget" || request.method === "setTitle" || request.method === "set_editor_text") {
    return null;
  }

  const cancel = () => {
    onAnswer(request.method === "confirm" ? { confirmed: false } : { cancelled: true });
  };

  const submit = () => {
    if (request.method === "confirm") {
      onAnswer({ confirmed: true });
      return;
    }
    if (request.method === "select") {
      if (selected !== null) onAnswer({ value: selected });
      return;
    }
    onAnswer({ value });
  };

  const handleDialogKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      cancel();
      return;
    }
    if (request.method !== "select" || event.altKey || event.ctrlKey || event.metaKey) return;
    const optionIndex = Number(event.key) - 1;
    if (Number.isInteger(optionIndex) && optionIndex >= 0 && optionIndex < Math.min(request.options.length, 9)) {
      event.preventDefault();
      setSelected(request.options[optionIndex]);
    }
  };

  const handleFieldKeyDown = (event: ReactKeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const shouldSubmit = request.method === "editor"
      ? event.key === "Enter" && (event.ctrlKey || event.metaKey)
      : event.key === "Enter" && !event.shiftKey;
    if (!shouldSubmit || event.nativeEvent.isComposing) return;
    event.preventDefault();
    submit();
  };

  const isConfirm = request.method === "confirm";
  const submitDisabled = request.method === "select" && selected === null;
  const shortcut = request.method === "select"
    ? "1-9 选择"
    : request.method === "editor"
      ? "Ctrl+Enter 提交"
      : request.method === "input"
        ? "Enter 提交"
        : null;

  return (
    <section
      className={`question-card question-${request.method}`}
      role="dialog"
      aria-label={request.title}
      onKeyDown={handleDialogKeyDown}
    >
      <header className="question-card-header">
        <span className="question-kind">
          {isConfirm ? <ShieldCheck size={14} /> : <CircleHelp size={14} />}
          {isConfirm ? "需要确认" : "需要你的回答"}
        </span>
        {shortcut && <span className="question-shortcut">{shortcut}</span>}
      </header>

      <h2>{request.title}</h2>

      {request.method === "confirm" && <div className="question-message">{request.message}</div>}

      {request.method === "select" && (
        <div className="question-options" role="radiogroup" aria-label={request.title}>
          {request.options.map((option, index) => {
            const active = selected === option;
            return (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={active}
                className={`question-option ${active ? "active" : ""}`}
                autoFocus={index === 0}
                onClick={() => setSelected(option)}
                onDoubleClick={() => onAnswer({ value: option })}
              >
                <span className="question-option-indicator">{active && <Check size={11} strokeWidth={2.5} />}</span>
                <span>{option}</span>
                {index < 9 && <kbd>{index + 1}</kbd>}
              </button>
            );
          })}
        </div>
      )}

      {request.method === "input" && (
        <input
          className="question-field"
          autoFocus
          value={value}
          placeholder={request.placeholder}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={handleFieldKeyDown}
        />
      )}
      {request.method === "editor" && (
        <textarea
          className="question-field"
          autoFocus
          rows={7}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={handleFieldKeyDown}
        />
      )}

      <footer className="question-footer">
        <button type="button" className="secondary-button" onClick={cancel}>
          <X size={14} />
          {isConfirm ? "拒绝" : "取消"}
        </button>
        <button type="button" className="primary-button" disabled={submitDisabled} onClick={submit}>
          {isConfirm ? <Check size={14} /> : <ArrowRight size={14} />}
          {isConfirm ? "允许一次" : "提交回答"}
        </button>
      </footer>
    </section>
  );
}
