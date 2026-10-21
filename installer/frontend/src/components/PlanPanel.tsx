import { useState } from "react";
import type { ReactNode } from "react";

import { PathText } from "@/components/PathText";
import { cn } from "@/lib/utils";
import type { ChangeInfo, Preview, RemovalInfo } from "@/lib/types";

/** Rows shown before the list collapses behind "Show all". Eight covers every
 *  ordinary install (four chrome files, the loader, the add-on, user.js and the
 *  prefs line), so the full promise is normally visible without a click. */
const VISIBLE = 8;

/**
 * PlanPanel is the promise the installer makes before it writes anything: the
 * exact list the Go layer resolved for the current selection.
 *
 * It replaces a dedicated review SCREEN, which had its own heading, its own
 * card-styled list with a folder or file icon on every row, and a badge for
 * every attribute. The plan is not a step — it is the answer to "what will this
 * do?", and it belongs on the same screen as the choices, next to the button
 * that acts on it.
 *
 * It is loaded automatically whenever the selection changes (see App), so it
 * always describes the selection the button will run. That is the safety
 * property the old wizard got from making the review a required step, kept
 * without the step: a run cannot start while the plan is unknown, stale or
 * refused, because the button is disabled in exactly those cases.
 */
export function PlanPanel({
  preview,
  error,
  planning,
}: {
  preview: Preview | null;
  error: string | null;
  planning: boolean;
}) {
  const [expanded, setExpanded] = useState(false);

  if (error) {
    return (
      <Shell title="What this will do">
        <Line tone="danger">{error}</Line>
      </Shell>
    );
  }
  if (!preview) {
    return (
      <Shell title="What this will do">
        <p className="text-[11px] text-muted-foreground">{planning ? "Checking…" : "Nothing selected yet."}</p>
      </Shell>
    );
  }

  const isRemoval = preview.action === "uninstall" || preview.action === "loader-remove";
  const changes = preview.changes ?? [];
  const removals = preview.removals ?? [];
  const unchanged = preview.unchanged ?? [];
  const rows: Row[] = isRemoval
    ? removals.map((r) => ({ path: r.path, detail: r.detail, tone: "removes", tags: removalTags(r) }))
    : changes.map((c) => ({ path: c.path, detail: c.detail, tone: "writes", tags: changeTags(c) }));

  const shown = expanded ? rows : rows.slice(0, VISIBLE);

  return (
    <Shell title={isRemoval ? `Files Lazyfox will remove (${rows.length})` : `What will be written (${rows.length})`}>
      {preview.action === "update" && (
        <Line tone="primary">
          Updating in place: the files below are replaced, in the profile you already use. Nothing is uninstalled
          first, and no profile is created — your tabs, add-ons and settings stay exactly as they are.
        </Line>
      )}
      {preview.createsProfile && (
        <Line tone="primary">
          The new profile is named before anything is written:{" "}
          <code className="selectable break-all">{preview.profile.dir}</code> — registered with Firefox, and its default
          for this install. Your own profile is not opened, modified or deleted.
        </Line>
      )}
      {preview.deletesProfile && (
        <Line tone="danger">
          The whole profile folder goes with it, because Lazyfox created it. Your bookmarks, history, saved logins and
          other add-ons live in profiles Lazyfox never touches.
        </Line>
      )}

      {rows.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">
          {isRemoval ? "Lazyfox does not look installed in this profile." : "Nothing to write."}
        </p>
      ) : (
        <>
          <ul className="divide-y divide-border overflow-hidden rounded-md border border-border">
            {shown.map((row) => (
              <li key={`${row.tone}:${row.path}`} className="flex items-start gap-3 px-3 py-2">
                <span
                  aria-hidden
                  className={cn(
                    "mt-0.5 w-2 shrink-0 font-mono text-[11px] leading-4",
                    row.tone === "removes" ? "text-destructive" : "text-muted-foreground",
                  )}
                >
                  {row.tone === "removes" ? "−" : "·"}
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-[11px] font-medium leading-4">{row.detail}</span>
                  <PathText path={row.path} wrap />
                </span>
                {row.tags.length > 0 && (
                  <span className="shrink-0 pt-0.5 text-[11px] text-muted-foreground">{row.tags.join(" · ")}</span>
                )}
              </li>
            ))}
          </ul>
          {rows.length > VISIBLE && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="self-start text-[11px] text-muted-foreground underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring/60"
            >
              {expanded ? "Show fewer" : `Show all ${rows.length}`}
            </button>
          )}
        </>
      )}

      {isRemoval && rows.length > 0 && removals.some((r) => r.restorable) && (
        <Line>
          Every file above is copied to a timestamped <code className="selectable">.lazyfox.uninst.bak</code> backup
          beside it before it is removed.
        </Line>
      )}

      {isRemoval && unchanged.length > 0 && (
        <p className="text-[11px] leading-4 text-muted-foreground">
          Left alone: {unchanged.map((u) => u.detail).join(", ")}.
        </p>
      )}
      {/* Only claimed when it is true: an uninstall that targets the profile
          Lazyfox created is not touching "your own profile" at all, and saying
          so there would be the kind of reassuring-but-wrong copy this window is
          supposed to be free of. */}
      {isRemoval && preview.profile && !preview.profile.owned && (
        <p className="text-[11px] leading-4 text-muted-foreground">
          Your own profile, and everything in it, is never touched.
        </p>
      )}

      {preview.needsAdmin && (
        <Line>
          One step writes into the Firefox installation folder, which needs administrator rights. Your system shows its
          own prompt for that step and nothing else.
        </Line>
      )}
      {isRemoval && !preview.needsAdmin && <Line>Nothing here needs administrator rights.</Line>}

      {(preview.warnings ?? []).map((w) => (
        <Line key={w} tone="warning">
          {w}
        </Line>
      ))}
    </Shell>
  );
}

type Row = { path: string; detail: string; tone: "writes" | "removes"; tags: string[] };

function changeTags(c: ChangeInfo): string[] {
  const tags: string[] = [];
  if (c.elevated) tags.push("needs admin");
  if (c.optional) tags.push("optional");
  if (c.kind === "profile") tags.push("profile");
  return tags;
}

function removalTags(r: RemovalInfo): string[] {
  const tags: string[] = [];
  if (r.owned) tags.push("Lazyfox profile");
  if (r.restorable) tags.push("backed up");
  return tags;
}

function Shell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{title}</h2>
      {children}
    </section>
  );
}

function Line({ tone = "muted", children }: { tone?: "muted" | "warning" | "danger" | "primary"; children: ReactNode }) {
  const rule =
    tone === "danger"
      ? "border-destructive"
      : tone === "warning"
        ? "border-warning"
        : tone === "primary"
          ? "border-primary"
          : "border-border";
  const text =
    tone === "danger"
      ? "text-destructive"
      : tone === "warning"
        ? "text-warning"
        : tone === "primary"
          ? "text-foreground"
          : "text-muted-foreground";
  return <p className={`border-l-2 ${rule} pl-3 text-[11px] leading-4 ${text}`}>{children}</p>;
}
