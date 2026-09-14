import { useEffect, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ArrowRight, Check, CircleHelp, ShieldCheck, X } from "lucide-react";
import type { ExtensionUIRequest } from "../types";
import {
  batchAskHeadline,
  headlineForUiRequest,
  isBatchAskComplete,
  parseBatchAskEnvelope,
  serializeBatchAskResponse,
  type BatchAskAnswer,
  type BatchAskEnvelope,
  type BatchAskQuestion,
} from "../lib/batchAsk";

const OTHER_VALUE = "__other__";

export function extensionRequestHeadline(request: ExtensionUIRequest): string {
  return headlineForUiRequest(
    request.method,
    "title" in request ? request.title : undefined,
    request.method === "input" ? request.placeholder : undefined,
  ) || "需要输入";
}

function BatchAskDialog({
  envelope,
  onAnswer,
}: {
  envelope: BatchAskEnvelope;
  onAnswer: (response: { value?: string; cancelled?: true }) => void;
}) {
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, BatchAskAnswer>>({});
  const [otherDraft, setOtherDraft] = useState("");
  const [otherOpen, setOtherOpen] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const question = envelope.questions[index] ?? envelope.questions[0];
  const complete = isBatchAskComplete(envelope, answers);
  const many = envelope.questions.length > 1;

  useEffect(() => {
    setIndex(0);
    setAnswers({});
    setOtherDraft("");
    setOtherOpen(false);
    setReviewing(false);
  }, [envelope]);

  const setAnswer = (next: BatchAskAnswer) => {
    setAnswers((current) => ({ ...current, [next.id]: next }));
  };

  const submit = () => {
    if (!complete) return;
    onAnswer({
      value: serializeBatchAskResponse(envelope.questions.map((item) => answers[item.id])),
    });
  };

  const goNext = () => {
    if (index < envelope.questions.length - 1) {
      setIndex(index + 1);
      setOtherOpen(false);
      setOtherDraft("");
      return;
    }
    if (envelope.review) {
      setReviewing(true);
      return;
    }
    submit();
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onAnswer({ cancelled: true });
      return;
    }
    if (reviewing || otherOpen || event.altKey || event.ctrlKey || event.metaKey) return;
    if (question.type !== "select" && question.type !== "confirm") return;
    const optionIndex = Number(event.key) - 1;
    const options = question.type === "confirm"
      ? [{ label: "是", value: "yes" }, { label: "否", value: "no" }]
      : [...(question.options ?? []), ...(question.allowOther !== false ? [{ label: "自行输入…", value: OTHER_VALUE }] : [])];
    if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= Math.min(options.length, 9)) return;
    event.preventDefault();
    pickOption(question, options[optionIndex].value, options[optionIndex].label);
  };

  const pickOption = (target: BatchAskQuestion, value: string, label: string) => {
    if (value === OTHER_VALUE) {
      setOtherOpen(true);
      return;
    }
    setOtherOpen(false);
    if (target.type === "confirm") {
      setAnswer({
        id: target.id,
        type: target.type,
        value: value === "yes" || value === "是",
        label,
      });
      return;
    }
    setAnswer({ id: target.id, type: target.type, value, label, wasCustom: false });
  };

  const commitOther = () => {
    const text = otherDraft.trim();
    if (!text) return;
    setAnswer({
      id: question.id,
      type: question.type,
      value: text,
      label: text,
      wasCustom: true,
    });
    setOtherOpen(false);
  };

  const current = answers[question.id];
  const selectOptions = question.type === "confirm"
    ? [{ label: "是", value: "yes", description: undefined as string | undefined }, { label: "否", value: "no", description: undefined }]
    : [
        ...(question.options ?? []),
        ...(question.allowOther !== false ? [{ label: "自行输入…", value: OTHER_VALUE, description: "输入自定义答案" }] : []),
      ];

  return (
    <section
      className="question-card question-batch"
      role="dialog"
      aria-label={batchAskHeadline(envelope)}
      onKeyDown={handleKeyDown}
    >
      <header className="question-card-header">
        <span className="question-kind">
          <CircleHelp size={14} />
          需要你的回答
        </span>
        <span className="question-shortcut">{many ? `${index + 1}/${envelope.questions.length}` : "1-9 选择"}</span>
      </header>

      {many && (
        <div className="question-tabs" role="tablist">
          {envelope.questions.map((item, tabIndex) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={tabIndex === index && !reviewing}
              className={`question-tab${tabIndex === index && !reviewing ? " active" : ""}${answers[item.id] ? " is-done" : ""}`}
              onClick={() => {
                setReviewing(false);
                setIndex(tabIndex);
                setOtherOpen(false);
              }}
            >
              {item.id}
            </button>
          ))}
          {envelope.review && (
            <button
              type="button"
              role="tab"
              className={`question-tab${reviewing ? " active" : ""}`}
              disabled={!complete}
              onClick={() => complete && setReviewing(true)}
            >
              审阅
            </button>
          )}
        </div>
      )}

      {reviewing ? (
        <>
          <h2>确认全部回答</h2>
          <ul className="question-review">
            {envelope.questions.map((item) => (
              <li key={item.id}>
                <strong>{item.question}</strong>
                <span>{answers[item.id]?.label ?? String(answers[item.id]?.value ?? "")}</span>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <>
          <h2>{question.question}</h2>
          {(question.type === "select" || question.type === "confirm") && (
            <div className="question-options" role="radiogroup" aria-label={question.question}>
              {selectOptions.map((option, optionIndex) => {
                const selectedValue = question.type === "confirm"
                  ? (current?.value === true ? "yes" : current?.value === false ? "no" : null)
                  : current?.wasCustom ? OTHER_VALUE : current?.value;
                const active = !otherOpen && selectedValue === option.value;
                return (
                  <button
                    key={`${option.value}-${optionIndex}`}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    className={`question-option ${active ? "active" : ""}`}
                    autoFocus={optionIndex === 0}
                    onClick={() => pickOption(question, option.value, option.label)}
                  >
                    <span className="question-option-indicator">{active && <Check size={11} strokeWidth={2.5} />}</span>
                    <span className="question-option-copy">
                      <span className="question-option-label">{option.label}</span>
                      {option.description ? <small className="question-option-desc">{option.description}</small> : null}
                    </span>
                    {optionIndex < 9 && <kbd>{optionIndex + 1}</kbd>}
                  </button>
                );
              })}
            </div>
          )}
          {(question.type === "input" || otherOpen) && (
            <input
              className="question-field"
              autoFocus={otherOpen || question.type === "input"}
              value={otherOpen ? otherDraft : (typeof current?.value === "string" ? current.value : "")}
              placeholder={question.placeholder ?? (otherOpen ? "输入自定义答案" : undefined)}
              onChange={(event) => {
                if (otherOpen) {
                  setOtherDraft(event.target.value);
                  return;
                }
                setAnswer({ id: question.id, type: question.type, value: event.target.value });
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
                event.preventDefault();
                if (otherOpen) commitOther();
              }}
            />
          )}
          {question.type === "editor" && (
            <textarea
              className="question-field"
              autoFocus
              rows={7}
              value={typeof current?.value === "string" ? current.value : (question.prefill ?? "")}
              onChange={(event) => setAnswer({ id: question.id, type: question.type, value: event.target.value })}
            />
          )}
          {otherOpen && (
            <div className="question-other-actions">
              <button type="button" className="secondary-button" onClick={() => setOtherOpen(false)}>返回选项</button>
              <button type="button" className="primary-button" disabled={!otherDraft.trim()} onClick={commitOther}>使用此答案</button>
            </div>
          )}
        </>
      )}

      <footer className="question-footer">
        <button type="button" className="secondary-button" onClick={() => onAnswer({ cancelled: true })}>
          <X size={14} />
          取消
        </button>
        {many && !reviewing && index > 0 && (
          <button type="button" className="secondary-button" onClick={() => setIndex(index - 1)}>上一题</button>
        )}
        {many && !reviewing && (index < envelope.questions.length - 1 || envelope.review) ? (
          <button type="button" className="primary-button" disabled={!current || current.value === null || current.value === ""} onClick={goNext}>
            <ArrowRight size={14} />
            {index < envelope.questions.length - 1 ? "下一题" : "审阅"}
          </button>
        ) : (
          <button type="button" className="primary-button" disabled={!complete} onClick={submit}>
            <ArrowRight size={14} />
            提交回答
          </button>
        )}
      </footer>
    </section>
  );
}

export function ExtensionDialog({
  request,
  onAnswer,
}: {
  request: ExtensionUIRequest;
  onAnswer: (response: { value?: string; confirmed?: boolean; cancelled?: true }) => void;
}) {
  const [value, setValue] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const batch = request.method === "input"
    ? parseBatchAskEnvelope(request.title, request.placeholder)
    : null;

  useEffect(() => {
    setValue(request.method === "editor" ? request.prefill ?? "" : "");
    setSelected(null);
  }, [request]);

  if (request.method === "notify" || request.method === "setStatus" || request.method === "setWidget" || request.method === "setTitle" || request.method === "set_editor_text") {
    return null;
  }

  if (batch) {
    return <BatchAskDialog envelope={batch} onAnswer={onAnswer} />;
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
