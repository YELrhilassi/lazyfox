import type { ActionId, ActionInfo } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * ActionRail is the window's left column: what this build can do.
 *
 * It replaces a numbered four-step wizard (Action → Target → Review → Run) whose
 * first step existed only to pick one of four options and whose rail used
 * circles, connector lines and a checkmark. Both are gone: the choices are a
 * plain list, they are always visible, and picking one is not a "step" — it is
 * the same decision the rest of the panel is a consequence of.
 *
 * THE RAIL NOW READS AS TWO GROUPS. Install / Update / Remove are what anyone
 * came here to do, so they stand alone at the top. The two chrome-loader actions
 * are power tools — they write into the Firefox installation folder and need
 * administrator rights — so they sit under a muted "Advanced" heading: still one
 * click away, no longer competing with the everyday three for the first read.
 *
 * The list is rendered from the Go layer's own actions (State.actions), so the
 * labels and descriptions live in one place and cannot disagree with what the
 * installer is willing to do.
 */

/** ADVANCED are the admin-grade loader actions, grouped below the main list. */
const ADVANCED: ReadonlySet<ActionId> = new Set(["loader-only", "loader-remove"]);

export function ActionRail({
  actions,
  value,
  onSelect,
  disabled,
}: {
  actions: ActionInfo[];
  value: ActionId;
  onSelect: (id: ActionId) => void;
  disabled?: boolean;
}) {
  const primary = actions.filter((a) => !ADVANCED.has(a.id));
  const advanced = actions.filter((a) => ADVANCED.has(a.id));

  const row = (a: ActionInfo) => {
    const current = a.id === value;
    return (
      <button
        key={a.id}
        type="button"
        aria-current={current ? "true" : undefined}
        disabled={disabled}
        onClick={() => onSelect(a.id)}
        className={cn(
          "rounded-md px-3 py-2 text-left outline-none transition-colors",
          "focus-visible:ring-2 focus-visible:ring-ring/60",
          current ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
          disabled && "cursor-not-allowed opacity-50 hover:bg-transparent",
        )}
      >
        <span className="block text-[13px] font-medium leading-5">{a.label}</span>
        <span className="mt-0.5 block text-[11px] leading-4 text-muted-foreground">{a.desc}</span>
      </button>
    );
  };

  return (
    <nav aria-label="What to do" className="flex w-52 shrink-0 flex-col gap-0.5 border-r border-border p-2">
      {primary.map(row)}
      {advanced.length > 0 && (
        <>
          <p className="mt-3 border-t border-border px-3 pt-3 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            Advanced
          </p>
          {advanced.map(row)}
        </>
      )}
    </nav>
  );
}