import type { ChangeEvent } from "react";

export interface JsonSchemaProperty {
  type?: string | readonly string[];
  title?: string;
  description?: string;
  default?: unknown;
  enum?: readonly (string | number | boolean)[];
  minimum?: number;
  maximum?: number;
}

export interface PluginConfigSchemaFormProps {
  pluginId: string;
  schema: Record<string, unknown>;
  value: Record<string, unknown>;
  disabled?: boolean;
  onChange: (next: Record<string, unknown>) => void;
}

function normalizeSchemaProperties(schema: Record<string, unknown> | undefined): Array<[string, JsonSchemaProperty]> {
  if (schema === undefined || typeof schema !== "object" || schema === null) return [];
  const rawProps = schema.properties;
  if (typeof rawProps !== "object" || rawProps === null || Array.isArray(rawProps)) return [];
  const entries: Array<[string, JsonSchemaProperty]> = [];
  for (const [key, rawProp] of Object.entries(rawProps as Record<string, unknown>)) {
    if (typeof rawProp !== "object" || rawProp === null || Array.isArray(rawProp)) continue;
    const prop = rawProp as JsonSchemaProperty;
    const primaryType = Array.isArray(prop.type) ? prop.type[0] : prop.type;
    const hasEnum = Array.isArray(prop.enum) && prop.enum.length > 0;
    if (
      hasEnum
      || primaryType === "boolean"
      || primaryType === "string"
      || primaryType === "number"
      || primaryType === "integer"
    ) {
      entries.push([key, prop]);
    }
  }
  return entries;
}

/** Returns true when `schema` exposes at least one scalar/enum property supported by `PluginConfigSchemaForm`. */
export function hasRenderableConfigSchema(schema: Record<string, unknown> | undefined): boolean {
  return normalizeSchemaProperties(schema).length > 0;
}

export function PluginConfigSchemaForm({
  pluginId,
  schema,
  value,
  disabled = false,
  onChange,
}: PluginConfigSchemaFormProps) {
  const properties = normalizeSchemaProperties(schema);
  if (properties.length === 0) return null;

  const updateField = (key: string, fieldValue: unknown) => {
    onChange({
      ...value,
      [key]: fieldValue,
    });
  };

  return (
    <div
      className="plugin-schema-form"
      data-testid={`plugin-schema-form-${pluginId}`}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "12px",
        padding: "10px 0 6px",
      }}
    >
      {properties.map(([key, prop]) => {
        const primaryType = Array.isArray(prop.type) ? prop.type[0] : prop.type;
        const fieldId = `plugin-schema-${pluginId}-${key}`;
        const label = prop.title && prop.title.trim() !== "" ? prop.title : key;
        const rawCurrent = key in value ? value[key] : prop.default;

        if (Array.isArray(prop.enum) && prop.enum.length > 0) {
          const enumValues = prop.enum;
          const selectedIndex = enumValues.findIndex((item) => item === rawCurrent);
          const effectiveIndex = selectedIndex >= 0 ? selectedIndex : 0;
          return (
            <div
              key={key}
              className="plugin-schema-field"
              style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "16px" }}
            >
              <div style={{ display: "flex", flexDirection: "column", gap: "2px", minWidth: 0 }}>
                <label htmlFor={fieldId} style={{ fontSize: "13px", fontWeight: 500 }}>
                  {label}
                </label>
                {prop.description && (
                  <span style={{ fontSize: "12px", color: "var(--qj-text-muted, var(--text-3))" }}>
                    {prop.description}
                  </span>
                )}
              </div>
              <select
                id={fieldId}
                disabled={disabled}
                value={String(effectiveIndex)}
                onChange={(event: ChangeEvent<HTMLSelectElement>) => {
                  const idx = Number.parseInt(event.target.value, 10);
                  const chosen = enumValues[idx];
                  if (chosen !== undefined) {
                    updateField(key, chosen);
                  }
                }}
                style={{
                  minWidth: "150px",
                  padding: "5px 8px",
                  borderRadius: "7px",
                  border: "1px solid var(--qj-border-default, var(--border))",
                  background: "var(--qj-bg-elevated, var(--panel))",
                  color: "var(--qj-text-primary, var(--text))",
                  fontSize: "12.5px",
                }}
              >
                {enumValues.map((option, idx) => (
                  <option key={`${key}-${String(option)}`} value={String(idx)}>
                    {String(option)}
                  </option>
                ))}
              </select>
            </div>
          );
        }

        if (primaryType === "boolean") {
          const checked = Boolean(rawCurrent);
          return (
            <div
              key={key}
              className="plugin-schema-field"
              style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "16px" }}
            >
              <div style={{ display: "flex", flexDirection: "column", gap: "2px", minWidth: 0 }}>
                <label htmlFor={fieldId} style={{ fontSize: "13px", fontWeight: 500 }}>
                  {label}
                </label>
                {prop.description && (
                  <span style={{ fontSize: "12px", color: "var(--qj-text-muted, var(--text-3))" }}>
                    {prop.description}
                  </span>
                )}
              </div>
              <input
                id={fieldId}
                type="checkbox"
                checked={checked}
                disabled={disabled}
                onChange={(event: ChangeEvent<HTMLInputElement>) => {
                  updateField(key, event.target.checked);
                }}
              />
            </div>
          );
        }

        if (primaryType === "number" || primaryType === "integer") {
          const numericVal = typeof rawCurrent === "number" && Number.isFinite(rawCurrent) ? String(rawCurrent) : "";
          return (
            <div
              key={key}
              className="plugin-schema-field"
              style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "16px" }}
            >
              <div style={{ display: "flex", flexDirection: "column", gap: "2px", minWidth: 0 }}>
                <label htmlFor={fieldId} style={{ fontSize: "13px", fontWeight: 500 }}>
                  {label}
                </label>
                {prop.description && (
                  <span style={{ fontSize: "12px", color: "var(--qj-text-muted, var(--text-3))" }}>
                    {prop.description}
                  </span>
                )}
              </div>
              <input
                id={fieldId}
                type="number"
                step={primaryType === "integer" ? 1 : "any"}
                min={prop.minimum}
                max={prop.maximum}
                disabled={disabled}
                value={numericVal}
                onChange={(event: ChangeEvent<HTMLInputElement>) => {
                  const raw = event.target.value;
                  if (raw.trim() === "") return;
                  const parsed = primaryType === "integer" ? Number.parseInt(raw, 10) : Number.parseFloat(raw);
                  if (Number.isFinite(parsed)) {
                    updateField(key, parsed);
                  }
                }}
                style={{
                  width: "150px",
                  padding: "5px 8px",
                  borderRadius: "7px",
                  border: "1px solid var(--qj-border-default, var(--border))",
                  background: "var(--qj-bg-elevated, var(--panel))",
                  color: "var(--qj-text-primary, var(--text))",
                  fontSize: "12.5px",
                }}
              />
            </div>
          );
        }

        const stringVal = typeof rawCurrent === "string" ? rawCurrent : rawCurrent == null ? "" : String(rawCurrent);
        return (
          <div
            key={key}
            className="plugin-schema-field"
            style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "16px" }}
          >
            <div style={{ display: "flex", flexDirection: "column", gap: "2px", minWidth: 0 }}>
              <label htmlFor={fieldId} style={{ fontSize: "13px", fontWeight: 500 }}>
                {label}
              </label>
              {prop.description && (
                <span style={{ fontSize: "12px", color: "var(--qj-text-muted, var(--text-3))" }}>
                  {prop.description}
                </span>
              )}
            </div>
            <input
              id={fieldId}
              type="text"
              disabled={disabled}
              value={stringVal}
              onChange={(event: ChangeEvent<HTMLInputElement>) => {
                updateField(key, event.target.value);
              }}
              style={{
                minWidth: "180px",
                padding: "5px 8px",
                borderRadius: "7px",
                border: "1px solid var(--qj-border-default, var(--border))",
                background: "var(--qj-bg-elevated, var(--panel))",
                color: "var(--qj-text-primary, var(--text))",
                fontSize: "12.5px",
              }}
            />
          </div>
        );
      })}
    </div>
  );
}
