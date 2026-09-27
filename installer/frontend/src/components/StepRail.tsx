import { CheckIcon } from "lucide-react";

import { cn } from "@/lib/utils";

const STEPS = ["Action", "Target", "Review", "Run"] as const;

/**
 * StepRail is where the user is in the install flow. It is derived from one
 * `current` index rather than from each step's own state, so the rail cannot
 * disagree with the panel.
 */
export function StepRail({ current, finished }: { current: number; finished: boolean }) {
  return (
    <ol className="flex items-center gap-1">
      {STEPS.map((label, i) => {
        const done = finished || i < current;
        const active = !finished && i === current;
        return (
          <li key={label} className="flex items-center gap-1">
            {i > 0 && <span className={cn("h-px w-4", done ? "bg-primary/60" : "bg-border")} aria-hidden />}
            <span
              className={cn(
                "flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium transition-colors",
                active && "bg-secondary text-foreground",
                done && !active && "text-primary",
                !active && !done && "text-muted-foreground",
              )}
              aria-current={active ? "step" : undefined}
            >
              <span
                className={cn(
                  "flex size-4 items-center justify-center rounded-full border text-[10px]",
                  done ? "border-primary bg-primary text-primary-foreground" : "border-border",
                  active && "border-primary text-primary",
                )}
              >
                {done ? <CheckIcon className="size-2.5" strokeWidth={3} /> : i + 1}
              </span>
              {label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
