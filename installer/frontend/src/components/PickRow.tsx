import type { ReactNode } from "react";

import { RadioGroupItem } from "@/components/ui/radio-group";
import { cn } from "@/lib/utils";

/**
 * PickRow is one choice in a list: a radio, a title, an optional hint and code
 * line, and right-aligned metadata. It exists so the Firefox list and the
 * profile list cannot drift into two different-looking pickers.
 */
export function PickRow({
  value,
  title,
  hint,
  code,
  meta,
  disabled,
  disabledReason,
}: {
  value: string;
  title: ReactNode;
  hint?: ReactNode;
  code?: ReactNode;
  meta?: ReactNode;
  disabled?: boolean;
  disabledReason?: string;
}) {
  return (
    <label
      htmlFor={value}
      title={disabled ? disabledReason : undefined}
      className={cn(
        "flex items-start gap-3 border-b border-border px-4 py-3 transition-colors last:border-b-0",
        disabled ? "cursor-not-allowed opacity-55" : "cursor-pointer hover:bg-accent/60",
        "has-[[data-state=checked]]:bg-primary/10",
      )}
    >
      <RadioGroupItem id={value} value={value} className="mt-0.5" disabled={disabled} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-sm font-medium leading-5">{title}</span>
        {hint ? <span className="text-xs leading-5 text-muted-foreground">{hint}</span> : null}
        {code ? <span className="min-w-0">{code}</span> : null}
      </span>
      {meta ? <span className="flex shrink-0 items-center gap-1 pt-0.5">{meta}</span> : null}
    </label>
  );
}
