"use client";

import { useState } from "react";
import type { DataType, PropertyDefinition } from "@/lib/instance-property-editor";

function stringify(value: unknown) {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function inputType(dataType: DataType) {
  if (dataType === "INTEGER" || dataType === "DECIMAL") return "number";
  if (dataType === "DATE") return "date";
  if (dataType === "DATETIME") return "datetime-local";
  if (dataType === "TEXT_ARRAY" || dataType === "JSON") return "textarea";
  return "text";
}

export function PropertyEditor({
  definitions,
  values,
  mode,
  onChange,
}: {
  definitions: PropertyDefinition[];
  values: Record<string, unknown>;
  mode: "managed" | "raw";
  onChange: (values: Record<string, unknown>) => void;
}) {
  const initialKeys = mode === "raw" ? Object.keys(values) : [];
  const [draft, setDraft] = useState<Record<string, unknown>>(() =>
    Object.fromEntries(Object.entries(values).map(([key, value]) => [key, stringify(value)])),
  );
  const [rawKeys, setRawKeys] = useState<string[]>(initialKeys);
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");

  const emit = (next: Record<string, unknown>) => {
    const clean: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(next)) {
      if (value === undefined || value === null || value === "") continue;
      clean[key] = value;
    }
    onChange(clean);
  };

  const update = (key: string, raw: string) => {
    const next = { ...draft, [key]: raw };
    setDraft(next);
    emit(next);
  };

  const addRaw = () => {
    const key = newKey.trim();
    if (!key || rawKeys.includes(key)) return;
    const nextKeys = [...rawKeys, key];
    const next = { ...draft, [key]: newValue };
    setRawKeys(nextKeys);
    setDraft(next);
    setNewKey("");
    setNewValue("");
    emit(next);
  };

  const fields =
    mode === "managed"
      ? definitions.map((definition) => ({
          key: definition.name,
          required: definition.required,
          dataType: definition.dataType,
          value: draft[definition.name] ?? "",
        }))
      : rawKeys.map((key) => ({ key, required: false, dataType: "TEXT" as DataType, value: draft[key] ?? "" }));

  return (
    <div className="property-editor">
      {fields.map((field) => (
        <label key={field.key} className={field.dataType === "TEXT_ARRAY" || field.dataType === "JSON" ? "property-field property-field-wide" : "property-field"}>
          <span>
            {field.key}
            {field.required && <em>*</em>}
          </span>
          {field.dataType === "BOOLEAN" ? (
            <select value={String(field.value)} onChange={(event) => update(field.key, event.target.value)}>
              <option value="">（空）</option>
              <option value="true">是</option>
              <option value="false">否</option>
            </select>
          ) : field.dataType === "TEXT_ARRAY" || field.dataType === "JSON" ? (
            <textarea value={String(field.value)} onChange={(event) => update(field.key, event.target.value)} />
          ) : (
            <input type={inputType(field.dataType)} value={String(field.value)} onChange={(event) => update(field.key, event.target.value)} />
          )}
        </label>
      ))}
      {mode === "raw" && (
        <div className="property-add">
          <input value={newKey} onChange={(event) => setNewKey(event.target.value)} placeholder="新属性名" />
          <input value={newValue} onChange={(event) => setNewValue(event.target.value)} placeholder="值" />
          <button type="button" onClick={addRaw}>添加</button>
        </div>
      )}
      {mode === "managed" && fields.length === 0 && <p className="property-empty">该类型尚未定义属性。</p>}
    </div>
  );
}
