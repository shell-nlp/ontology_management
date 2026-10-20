"use client";

import { Boxes, CircleDot, Link2 } from "lucide-react";
import type { ReasoningRun } from "@/lib/reasoning/types";
import "../qa-studio.css";

export function Evidence({ run, onOpenObject }: { run: ReasoningRun; onOpenObject: (id: string) => void }) {
  const concepts = run.evidence.filter((item) => item.kind === "OBJECT_TYPE" || item.kind === "RELATION_TYPE" || item.kind === "ACTION" || item.kind === "INTERFACE" || item.kind === "METRIC");
  const objects = run.evidence.filter((item) => item.kind === "OBJECT");
  const relationships = run.evidence.filter((item) => item.kind === "RELATIONSHIP");
  if (!concepts.length && !objects.length && !relationships.length) return null;
  return (
    <div className="qa-evidence">
      <span className="qa-evidence-label">依据</span>
      <div className="qa-chips">
        {concepts.map((item) => <span className="qa-chip concept" key={`${item.kind}-${item.id}`}><Boxes size={11} />{item.label}</span>)}
        {objects.map((item) => (
          <button className="qa-chip object" key={item.id} onClick={() => onOpenObject(item.id)} title={item.id}>
            <CircleDot size={11} />{item.label}
          </button>
        ))}
        {relationships.map((item) => <span className="qa-chip concept" key={item.id}><Link2 size={11} />{item.label}</span>)}
      </div>
    </div>
  );
}
