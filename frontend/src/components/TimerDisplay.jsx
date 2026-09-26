import React from "react";
import { fmtTime } from "@/lib/api";

export function TimerDisplay({ seconds, label = "TIME REMAINING" }) {
  // Three-tier colour coding, matching the owner's Live Session timer:
  // red + pulse under 30s, amber under 2 min, purple otherwise.
  let toneClass;
  if (seconds <= 30) {
    toneClass = "text-[var(--kink-danger)] text-glow-danger pulse-dot";
  } else if (seconds <= 120) {
    toneClass = "text-[#ffb454]";
  } else {
    toneClass = "text-[var(--kink-purple)] text-glow-purple";
  }
  return (
    <div className="flex flex-col items-center" data-testid="timer-display">
      <span className="font-display text-[0.7rem] tracking-[0.25em] text-[var(--kink-muted)] mb-2">
        {label}
      </span>
      <span
        className={`font-mono-data font-extrabold tabular-nums text-6xl sm:text-7xl leading-none ${toneClass}`}
        data-testid="timer-value"
      >
        {fmtTime(seconds)}
      </span>
    </div>
  );
}
