"use client";

import type { GaugeView } from "./gaugeState";
import styles from "./StaffGauge.module.css";

export function StaffGauge({
  view, gate, size = "sm", showNumber = true,
}: { view: GaugeView; gate: number; size?: "xs" | "sm" | "lg"; showNumber?: boolean }) {
  const cls = [
    styles.frame, styles[size],
    view.state === "below" && styles.below,
    view.state === "no-reading" && styles.noReading,
    view.state === "pending" && styles.pending,
    view.state === "rejected" && styles.rejected,
  ].filter(Boolean).join(" ");
  const measured = view.state !== "pending" && view.state !== "no-reading" && view.state !== "rejected";

  return (
    <span className={styles.wrap}>
      <span
        role="meter"
        aria-valuemin={0}
        aria-valuemax={1}
        aria-valuenow={measured ? view.level : 0}
        aria-valuetext={view.ariaText}
        aria-label={view.ariaText}
        className={cls}
        title={view.ariaText}
      >
        {measured && <span className={styles.fill} style={{ height: `${view.level * 100}%` }} />}
        {view.state === "checked" && <span className={styles.cap} style={{ bottom: `calc(${view.level * 100}% - 1px)` }} />}
        {view.state === "rejected" && <span className={styles.rejectedStrike} />}
        {view.state !== "no-reading" && view.state !== "pending" && (
          <span className={styles.line} style={{ bottom: `calc(${gate * 100}% - 1px)` }} />
        )}
      </span>
      {showNumber && view.number && (
        <span className={`${styles.num} ${size === "lg" ? styles.lgNum : ""}`} aria-hidden>
          {view.number}
        </span>
      )}
    </span>
  );
}
