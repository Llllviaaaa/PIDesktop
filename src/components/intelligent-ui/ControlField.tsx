import type { IntelligentUiControlItem, IntelligentUiStateValue } from "../../lib/intelligentUi";

export function ControlField({
  item,
  value,
  onChange,
}: {
  item: IntelligentUiControlItem;
  value: IntelligentUiStateValue | undefined;
  onChange: (key: string, next: IntelligentUiStateValue) => void;
}) {
  const unitText = item.unit ? ` ${item.unit}` : "";

  if (item.kind === "slider") {
    const min = typeof item.min === "number" ? item.min : 0;
    const max = typeof item.max === "number" ? item.max : 100;
    const step = typeof item.step === "number" && item.step > 0 ? item.step : 1;
    const numeric = typeof value === "number" && Number.isFinite(value) ? value : min;
    return (
      <label className="pi-iui-control pi-iui-control-slider">
        <div className="pi-iui-control-head">
          <span className="pi-iui-control-label">{item.label}</span>
          <output className="pi-iui-control-value">
            {Number.isInteger(step) ? numeric : numeric.toFixed(String(step).split(".")[1]?.length ?? 1)}
            {unitText}
          </output>
        </div>
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={numeric}
          aria-label={item.label}
          onChange={(event) => onChange(item.key, Number(event.target.value))}
        />
        {item.help && <span className="pi-iui-control-help">{item.help}</span>}
      </label>
    );
  }

  if (item.kind === "toggle") {
    const checked = Boolean(value);
    return (
      <label className="pi-iui-control pi-iui-control-toggle">
        <div className="pi-iui-control-toggle-row">
          <div className="pi-iui-control-copy">
            <span className="pi-iui-control-label">{item.label}</span>
            {item.help && <span className="pi-iui-control-help">{item.help}</span>}
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={checked}
            aria-label={item.label}
            className={`pi-iui-switch${checked ? " is-on" : ""}`}
            onClick={() => onChange(item.key, !checked)}
          >
            <span className="pi-iui-switch-thumb" />
          </button>
        </div>
      </label>
    );
  }

  if (item.kind === "select") {
    const options = item.options ?? [];
    const current = value !== undefined ? String(value) : String(options[0]?.value ?? "");
    return (
      <label className="pi-iui-control">
        <span className="pi-iui-control-label">{item.label}</span>
        <select
          className="pi-iui-input"
          aria-label={item.label}
          value={current}
          onChange={(event) => {
            const raw = event.target.value;
            const matched = options.find((opt) => String(opt.value) === raw);
            onChange(item.key, matched ? matched.value : raw);
          }}
        >
          {options.map((opt) => (
            <option key={String(opt.value)} value={String(opt.value)}>
              {opt.label}
            </option>
          ))}
        </select>
        {item.help && <span className="pi-iui-control-help">{item.help}</span>}
      </label>
    );
  }

  if (item.kind === "number") {
    const numeric = typeof value === "number" && Number.isFinite(value) ? value : 0;
    return (
      <label className="pi-iui-control">
        <div className="pi-iui-control-head">
          <span className="pi-iui-control-label">{item.label}</span>
          {item.unit && <span className="pi-iui-control-unit">{item.unit}</span>}
        </div>
        <input
          type="number"
          className="pi-iui-input"
          aria-label={item.label}
          min={item.min}
          max={item.max}
          step={item.step ?? 1}
          value={numeric}
          onChange={(event) => {
            const parsed = Number(event.target.value);
            onChange(item.key, Number.isFinite(parsed) ? parsed : 0);
          }}
        />
        {item.help && <span className="pi-iui-control-help">{item.help}</span>}
      </label>
    );
  }

  return (
    <label className="pi-iui-control">
      <span className="pi-iui-control-label">{item.label}</span>
      <input
        type="text"
        className="pi-iui-input"
        aria-label={item.label}
        placeholder={item.placeholder}
        value={value !== undefined ? String(value) : ""}
        onChange={(event) => onChange(item.key, event.target.value)}
      />
      {item.help && <span className="pi-iui-control-help">{item.help}</span>}
    </label>
  );
}
