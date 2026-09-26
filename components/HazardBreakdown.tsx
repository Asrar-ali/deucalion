"use client";

/**
 * "What is in this file": how many classified posts fall in each hazard. Counts are model
 * proposals. Each row is a button that filters the reports view to that hazard.
 */

import { useMemo } from "react";
import { count } from "../lib/display";
import type { EventProfile, FloodRecord, HazardType } from "../lib/types";

const HAZARDS: Array<{ key: HazardType; label: string }> = [
  { key: "flood", label: "Flood" },
  { key: "fire", label: "Fire" },
  { key: "quake", label: "Earthquake" },
  { key: "storm", label: "Storm" },
  { key: "other", label: "Other" },
];

export function HazardBreakdown({
  records,
  profile,
  active,
  onPick,
}: {
  records: FloodRecord[];
  profile: EventProfile | null;
  active: HazardType | null;
  onPick: (hazard: HazardType | null) => void;
}) {
  const { counts, total } = useMemo(() => {
    const c: Record<HazardType, number> = { flood: 0, fire: 0, quake: 0, storm: 0, other: 0 };
    let t = 0;
    for (const r of records) {
      const h = r.labels.hazard?.value;
      if (h && h in c) {
        c[h] += 1;
        t += 1;
      }
    }
    return { counts: c, total: t };
  }, [records]);

  const present = HAZARDS.filter((h) => counts[h.key] > 0).length;
  if (total === 0 || (!profile?.mixed && present < 2)) return null;

  return (
    <section
      aria-labelledby="hazard-breakdown-h"
      className="rounded-md border p-3"
      style={{ borderColor: "var(--line)", background: "var(--surface-raised)" }}
    >
      <h2 id="hazard-breakdown-h" className="text-sm font-semibold" style={{ color: "var(--text)" }}>
        What is in this file
      </h2>
      <p className="mb-2 text-xs" style={{ color: "var(--text-muted)" }}>
        Counts are model proposals, not confirmed facts. Pick a row to filter Reports.
      </p>
      <ul className="flex flex-col gap-1">
        {HAZARDS.map(({ key, label }) => {
          const n = counts[key];
          const share = total ? n / total : 0;
          const isFlood = key === "flood";
          const on = active === key;
          const fill = isFlood ? "var(--accent)" : "var(--inert)";
          return (
            <li key={key}>
              <button
                type="button"
                aria-pressed={on}
                disabled={n === 0}
                onClick={() => onPick(on ? null : key)}
                className="grid w-full grid-cols-[6rem_1fr_9rem] items-center gap-2 rounded px-2 py-1 text-left text-sm disabled:opacity-60"
                style={{
                  background: on ? "var(--accent-weak)" : "transparent",
                  outline: on ? "2px solid var(--accent)" : "none",
                  color: "var(--text)",
                  fontWeight: isFlood ? 600 : 400,
                }}
              >
                <span>{label}{isFlood ? " (target)" : ""}</span>
                <span
                  aria-hidden="true"
                  className="h-2.5 overflow-hidden rounded-sm"
                  style={{ background: "var(--surface-inset)" }}
                >
                  <span
                    className="block h-full"
                    style={{ width: `${Math.max(share * 100, n ? 2 : 0)}%`, background: fill }}
                  />
                </span>
                <span className="text-right font-mono text-xs" style={{ color: "var(--text-muted)" }}>
                  {count(n)} posts, {Math.round(share * 100)}%
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {active && (
        <button
          type="button"
          onClick={() => onPick(null)}
          className="mt-2 text-xs underline"
          style={{ color: "var(--text-muted)" }}
        >
          Clear hazard filter
        </button>
      )}
    </section>
  );
}
