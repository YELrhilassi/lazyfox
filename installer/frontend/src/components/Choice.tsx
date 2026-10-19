import type { ReactNode } from "react";

import { Checkbox } from "@/components/ui/checkbox";
import { RadioGroupItem } from "@/components/ui/radio-group";
import { cn } from "@/lib/utils";

/**
 * Choice is one radio row in a flat list, and Toggle is its checkbox twin.
 *
 * They replace PickRow, which carried a title, a hint, a path line AND a row of
 * badges — up to five chips per row on the profile list, which is where "this
 * looks generated" came from. A row here says one thing at each level: the name,
 * a muted line of facts, the path, and at most ONE trailing word. Facts that
 * used to be chips ("in use", "recommended", "Lazyfox installed", "default") are
 * now text, and colour is used only where it changes a decision: the
 * recommendation is the accent, a profile Firefox is holding open is a warning.
 *
 * There is no card, no shadow and no inner surface: a container draws one
 * hairline and its rows carry the separators.
 */

/** toneClass is the trailing word's colour. Muted is the default: most facts are
 *  just facts. */
const TONE = {
  muted: "text-muted-foreground",
  primary: "text-primary",
  warning: "text-warning",
  success: "text-success",
  danger: "text-destructive",
} as const;

export function Choice({
  value,
  title,
  meta,
  code,
  trailing,
  tone = "muted",
  disabled,
  disabledReason,
}: {
  value: string;
  title: ReactNode;
  meta?: ReactNode;
  code?: ReactNode;
  trailing?: ReactNode;
  tone?: keyof typeof TONE;
  disabled?: boolean;
  disabledReason?: string;
}) {
  return (
    <label
      htmlFor={value}
      title={disabled ? disabledReason : undefined}
      className={cn(
        "flex items-start gap-3 px-3 py-2.5 transition-colors",
        disabled ? "cursor-not-allowed opacity-55" : "cursor-pointer hover:bg-accent/60",
        "has-[[data-state=checked]]:bg-accent",
      )}
    >
      <RadioGroupItem id={value} value={value} className="mt-0.5" disabled={disabled} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[13px] font-medium leading-5">{title}</span>
        {meta ? <span className="text-[11px] leading-4 text-muted-foreground">{meta}</span> : null}
        {code}
      </span>
      {trailing ? <span className={cn("shrink-0 pt-0.5 text-[11px]", TONE[tone])}>{trailing}</span> : null}
    </label>
  );
}

/** Toggle is a checkbox row, in the same list as the choices. */
export function Toggle({
  label,
  meta,
  checked,
  onChange,
  disabled,
}: {
  label: ReactNode;
  meta?: ReactNode;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label
      className={cn(
        "flex items-start gap-3 px-3 py-2.5 transition-colors",
        disabled ? "cursor-not-allowed opacity-55" : "cursor-pointer hover:bg-accent/60",
      )}
    >
      <Checkbox
        checked={checked}
        disabled={disabled}
        onCheckedChange={(v) => onChange(v === true)}
        className="mt-0.5"
      />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-[13px] font-medium leading-5">{label}</span>
        {meta ? <span className="text-[11px] leading-4 text-muted-foreground">{meta}</span> : null}
      </span>
    </label>
  );
}
