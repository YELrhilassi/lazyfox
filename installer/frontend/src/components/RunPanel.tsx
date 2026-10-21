import { useEffect, useRef } from "react";

import { cn } from "@/lib/utils";
import type { Preview, Result, Step } from "@/lib/types";

/**
 * RunPanel is the operation itself: the step lines the Go layer emits, then the
 * outcome.
 *
 * It replaces a run step built around a black, rounded log box floating in a
 * panel — a terminal reproduced inside the window. The lines are the same lines,
 * set in the window's own monospace on the window's own background, separated
 * from the plan above by a hairline. What it keeps, deliberately, is that the
 * log STAYS on screen after the run: on a failure it is the only evidence of
 * where it stopped.
 */
export function RunPanel({
  preview,
  steps,
  running,
  result,
}: {
  preview: Preview | null;
  steps: Step[];
  running: boolean;
  result: Result | null;
}) {
  const logRef = useRef<HTMLDivElement>(null);

  // Follow the tail while the run is in progress, so the newest line is the one
  // in view without the user scrolling.
  useEffect(() => {
    const el = logRef.current;
    if (el && running) el.scrollTop = el.scrollHeight;
  }, [steps.length, running]);

  const failures = result?.failures ?? [];

  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-baseline justify-between gap-4">
        <h1 className="text-[15px] font-semibold leading-6">
          {running ? "Working…" : result?.ok ? "Done" : result ? "Stopped" : "Starting…"}
        </h1>
        {preview && (
          <p className="min-w-0 truncate text-[11px] text-muted-foreground" title={preview.summary}>
            {preview.summary}
          </p>
        )}
      </header>

      <div
        ref={logRef}
        role="log"
        aria-live="polite"
        className="max-h-72 overflow-auto rounded-md border border-border px-3 py-2 font-mono text-[11px] leading-5"
      >
        {steps.length === 0 && <p className="text-muted-foreground">Starting…</p>}
        {steps.map((s, i) => (
          <p
            key={i}
            className={cn(
              "whitespace-pre-wrap break-words",
              s.kind === "warn" && "text-warning",
              s.kind === "note" && "text-muted-foreground",
              s.kind === "step" && "text-foreground",
            )}
          >
            {s.kind === "warn" ? "! " : s.kind === "note" ? "· " : "› "}
            {s.text}
          </p>
        ))}
      </div>

      {result && (
        <div className="flex flex-col gap-2">
          <p className={cn("text-[13px] font-medium", result.ok ? "text-success" : "text-destructive")}>
            {result.text}
          </p>
          {/* Only after an INSTALL or UPDATE: a removal that ended with "press ;
              to open the overlay" would advertise the very thing the run just
              took away. */}
          {result.ok && result.state === "installed" && (
            <p className="text-[11px] leading-4 text-muted-foreground">
              {result.pendingEnable
                ? "Start Firefox once and the add-on loads with it. Then press ; on any page."
                : "Press ; on any page to open the command overlay."}
            </p>
          )}
          {result.ok && result.state === "updated" && (
            <p className="text-[11px] leading-4 text-muted-foreground">
              Restart Firefox to finish applying the update. Your tabs, add-ons and settings are untouched.
            </p>
          )}
          {failures.length > 0 && (
            <ul className="flex flex-col gap-1">
              {failures.map((f) => (
                <li key={f} className="flex gap-2 text-[11px] leading-4 text-muted-foreground">
                  <span aria-hidden className="font-mono text-destructive">
                    −
                  </span>
                  <span className="min-w-0 whitespace-pre-wrap">{f}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
