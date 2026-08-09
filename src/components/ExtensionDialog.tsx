import { useEffect, useState } from "react";
import type { ExtensionUIRequest } from "../types";

export function ExtensionDialog({
  request,
  onAnswer,
}: {
  request: ExtensionUIRequest;
  onAnswer: (response: { value?: string; confirmed?: boolean; cancelled?: true }) => void;
}) {
  const [value, setValue] = useState("");

  useEffect(() => {
    setValue(request.method === "editor" ? request.prefill ?? "" : "");
  }, [request]);

  if (request.method === "notify" || request.method === "setStatus" || request.method === "setWidget" || request.method === "setTitle" || request.method === "set_editor_text") {
    return null;
  }

  return (
      <section className="permission-dialog permission-inline" role="dialog" aria-label="Pi 请求权限">
        <div className="permission-badge">Pi 请求权限</div>
        <h2>{request.title}</h2>
        {request.method === "confirm" && <pre className="permission-message">{request.message}</pre>}

        {request.method === "select" && (
          <div className="permission-options">
            {request.options.map((option) => (
              <button key={option} onClick={() => onAnswer({ value: option })}>{option}</button>
            ))}
          </div>
        )}

        {request.method === "input" && (
          <input autoFocus value={value} placeholder={request.placeholder} onChange={(event) => setValue(event.target.value)} />
        )}
        {request.method === "editor" && (
          <textarea autoFocus rows={9} value={value} onChange={(event) => setValue(event.target.value)} />
        )}

        {request.method !== "select" && (
          <footer>
            <button className="secondary-button" onClick={() => onAnswer(request.method === "confirm" ? { confirmed: false } : { cancelled: true })}>
              {request.method === "confirm" ? "拒绝" : "取消"}
            </button>
            <button className="primary-button" onClick={() => onAnswer(request.method === "confirm" ? { confirmed: true } : { value })}>
              {request.method === "confirm" ? "允许一次" : "提交"}
            </button>
          </footer>
        )}
        {request.method === "select" && (
          <button className="dialog-cancel-link" onClick={() => onAnswer({ cancelled: true })}>取消</button>
        )}
      </section>
  );
}
