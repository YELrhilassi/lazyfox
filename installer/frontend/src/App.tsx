import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Loader2Icon } from "lucide-react";

import { ActionRail } from "@/components/ActionRail";
import { PlanPanel } from "@/components/PlanPanel";
import { RunPanel } from "@/components/RunPanel";
import { SettingsPanel } from "@/components/SettingsPanel";
import { Button } from "@/components/ui/button";
import { installer, onStep } from "@/lib/installer";
import { actionVerb, defaultAction, initialSelection, needsProfile, resetForAction, targetSummary, toRequest } from "@/lib/selection";
import {
  PROFILE_NAME_RE,
  type ActionId,
  type Preview,
  type Result,
  type Selection,
  type State,
  type Step,
} from "@/lib/types";

/**
 * App owns the window: which action, the selection, the plan for that selection,
 * and the run. Every fact about the machine comes from the Go layer and every
 * action goes back to it, so the window can be redesigned without changing what
 * the installer does.
 *
 * THE FLOW IS ONE SCREEN. There used to be four wizard phases (Action → Target →
 * Review → Run), each with its own heading, its own "Continue" button and a rail
 * of numbered circles; reaching an ordinary install took three clicks plus a
 * page it never needed to show. Now the action list is always visible, the
 * choices are one scrolling column, the plan loads itself beside them, and the
 * only button that moves anything forward is the one that runs the operation.
 *
 * WHAT REPLACED THE REVIEW STEP'S SAFETY. The run button is enabled only while
 * the plan on screen belongs to the selection that is currently chosen: the plan
 * is keyed by the request it was computed from, and any change to the selection
 * invalidates that key. A run therefore cannot start from a stale promise, and a
 * plan the Go layer refused disables the button and shows the reason where the
 * offending choice is, instead of walking the user to a dead end.
 */
type Phase = "configure" | "run";

/** How long to wait after a change before asking the Go layer for a new plan.
 *  Long enough to swallow a burst of keystrokes in the profile-name field,
 *  short enough that the plan feels like it is simply there. */
const PLAN_DEBOUNCE_MS = 180;

export function App() {
  const [state, setState] = useState<State | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [sel, setSel] = useState<Selection | null>(null);

  // The plan, tagged with the request it answers. `key === requestKey` is what
  // makes the run button trustworthy.
  const [plan, setPlan] = useState<{ key: string; preview: Preview } | null>(null);
  const [planError, setPlanError] = useState<{ key: string; message: string } | null>(null);
  const [planning, setPlanning] = useState(false);

  const [phase, setPhase] = useState<Phase>("configure");
  const [steps, setSteps] = useState<Step[]>([]);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<Result | null>(null);

  // The profile name a plan promised. Held so the run creates exactly the
  // folder the plan showed, not a freshly generated one.
  const pinnedName = useRef("");

  useEffect(() => {
    let cancelled = false;
    installer
      .state()
      .then((st) => {
        if (cancelled) return;
        setState(st);
        setSel(initialSelection(st, defaultAction(st)));
      })
      .catch((err: Error) => {
        if (!cancelled) setFatal(err.message);
      });
    const off = onStep((s) => setSteps((prev) => [...prev, s]));
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  /** requestKey identifies the selection a plan was computed for. */
  const requestKey = useMemo(() => (sel ? JSON.stringify(toRequest(sel)) : ""), [sel]);

  const update = useCallback((patch: Partial<Selection>) => {
    // A new destination means the plan may name a different folder, so the
    // previous promise stops applying the moment the destination changes.
    if (
      patch.newProfile !== undefined ||
      patch.newProfileName !== undefined ||
      patch.profileDir !== undefined ||
      patch.installDir !== undefined
    ) {
      pinnedName.current = "";
    }
    setSel((prev) => (prev ? { ...prev, ...patch } : prev));
  }, []);

  const onAction = useCallback(
    (id: ActionId) => {
      if (!state) return;
      // A choice made for one action must not silently carry into another: the
      // profile worth recommending for an install is not the one worth offering
      // for an uninstall.
      setSel((prev) => (prev ? resetForAction(state, prev, id) : prev));
      pinnedName.current = "";
      setPlan(null);
      setPlanError(null);
      // Picking a new action after a finished run is not a re-run: it goes back
      // to configuring, so the previous run's log and outcome cannot linger
      // under a different action's heading.
      setResult(null);
      setSteps([]);
      setPhase("configure");
    },
    [state],
  );

  /**
   * Keep a plan for whatever is selected. This is the "review" that used to be a
   * page: it is a read-only call, so running it on every change costs a round
   * trip and no writes, and in exchange the button below the plan always
   * describes itself with the current selection.
   */
  useEffect(() => {
    if (!sel || phase !== "configure" || requestKey === "") return;
    if (plan?.key === requestKey || planError?.key === requestKey) return;

    let cancelled = false;
    setPlanning(true);
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const preview = await installer.preview(toRequest(sel, pinnedName.current));
          if (cancelled) return;
          if (preview.createsProfile && preview.profile?.name) pinnedName.current = preview.profile.name;
          setPlan({ key: requestKey, preview });
          setPlanError(null);
        } catch (err) {
          if (cancelled) return;
          setPlan(null);
          setPlanError({ key: requestKey, message: (err as Error).message });
        } finally {
          if (!cancelled) setPlanning(false);
        }
      })();
    }, PLAN_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      setPlanning(false);
    };
  }, [sel, requestKey, phase, plan, planError]);

  const refused = planError?.key === requestKey ? planError.message : null;
  const currentPlan = plan?.key === requestKey ? plan.preview : null;

  /** blocker is the one thing, if any, that stops the run from being possible. */
  const blocker = useMemo(() => (state && sel ? blockerFor(state, sel) : null), [state, sel]);
  const ready = Boolean(sel && currentPlan && !planning && !blocker && phase === "configure");

  async function run() {
    if (!sel) return;
    setRunning(true);
    setResult(null);
    setSteps([]);
    setPhase("run");
    try {
      setResult(await installer.run(toRequest(sel, pinnedName.current)));
    } catch (err) {
      setResult({ ok: false, state: "failed", text: (err as Error).message, failures: null, pendingEnable: false });
    } finally {
      setRunning(false);
    }
  }

  async function startOver() {
    pinnedName.current = "";
    setPlan(null);
    setPlanError(null);
    setResult(null);
    setSteps([]);
    setPhase("configure");
    try {
      const st = await installer.state();
      setState(st);
      setSel(initialSelection(st, defaultAction(st)));
    } catch (err) {
      setFatal((err as Error).message);
    }
  }

  if (fatal) {
    return (
      <Shell>
        <div className="flex flex-col gap-2">
          <h1 className="text-[15px] font-semibold">The installer could not start.</h1>
          <p className="selectable max-w-prose whitespace-pre-wrap text-xs leading-5 text-muted-foreground">{fatal}</p>
          <div className="mt-2">
            <Button size="sm" onClick={() => installer.quit()}>
              Close
            </Button>
          </div>
        </div>
      </Shell>
    );
  }

  if (!state || !sel) {
    return (
      <Shell>
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2Icon className="size-3.5 animate-spin" />
          Looking for Firefox…
        </p>
      </Shell>
    );
  }

  const action = state.actions.find((a) => a.id === sel.action);
  const destructive = sel.action === "uninstall" || sel.action === "loader-remove";
  const note = footerNote({ phase, running, refused, blocker, plan: currentPlan, planning, state, sel });

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-4">
        <span className="text-[13px] font-semibold tracking-tight">Lazyfox</span>
        <span className="text-[11px] text-muted-foreground">installer</span>
        {/* Which Firefox, and which add-on version this binary carries — read
            from the embedded xpi, so it names the build a run would actually
            write rather than a version someone remembered to type here. */}
        <span className="ml-auto truncate text-[11px] text-muted-foreground">
          {[
            state.channelLabel,
            state.addonVersion ? `add-on ${state.addonVersion}` : "",
            state.updateAvailable ? "update available" : "",
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* The rail stays live after a run (only a run in flight disables it),
            so "actually, remove it instead" is one click rather than Close and
            start the installer again. */}
        <ActionRail actions={state.actions} value={sel.action} onSelect={onAction} disabled={running} />

        <main className="flex min-w-0 flex-1 flex-col overflow-auto px-6 py-5">
          {phase === "configure" ? (
            <>
              <SettingsPanel
                state={state}
                sel={sel}
                heading={action?.label ?? ""}
                description={action?.desc ?? ""}
                onChange={update}
              />
              <div className="mt-6 border-t border-border pt-5">
                <PlanPanel preview={currentPlan} error={refused} planning={planning} />
              </div>
            </>
          ) : (
            <RunPanel preview={currentPlan} steps={steps} running={running} result={result} />
          )}
        </main>
      </div>

      <footer className="flex shrink-0 items-center gap-3 border-t border-border px-4 py-3">
        {/* The summary line is the plan's own words for where this lands, or the
            reason the button is disabled. It is one line and it truncates: the
            footer is a status bar, not a second review screen. */}
        <p className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground" title={note}>
          {note}
        </p>
        {phase === "configure" ? (
          <Button
            size="sm"
            variant={destructive ? "destructive" : "default"}
            disabled={!ready}
            onClick={() => void run()}
          >
            {planning && <Loader2Icon className="animate-spin" />}
            {actionVerb(sel.action)}
          </Button>
        ) : (
          <>
            {!running && (
              <Button size="sm" variant="outline" onClick={() => void startOver()}>
                Start over
              </Button>
            )}
            <Button size="sm" disabled={running} onClick={() => installer.quit()}>
              Close
            </Button>
          </>
        )}
      </footer>
    </div>
  );
}

/** Shell is the window frame for the two states that have no controls: loading
 *  and a fatal error. */
function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-4">
        <span className="text-[13px] font-semibold tracking-tight">Lazyfox</span>
        <span className="text-[11px] text-muted-foreground">installer</span>
      </header>
      <main className="flex min-h-0 flex-1 flex-col overflow-auto px-6 py-5">{children}</main>
    </div>
  );
}

/**
 * footerNote is the one line beside the button: what is about to happen, or what
 * is stopping it. It prefers the plan's own summary — computed by the Go layer
 * from the same selection the button will run — over anything the window could
 * say for itself.
 */
function footerNote({
  phase,
  running,
  refused,
  blocker,
  plan,
  planning,
  state,
  sel,
}: {
  phase: Phase;
  running: boolean;
  refused: string | null;
  blocker: string | null;
  plan: Preview | null;
  planning: boolean;
  state: State;
  sel: Selection;
}): string {
  if (phase === "run") return running ? "Working…" : "Finished.";
  if (blocker) return blocker;
  if (refused) return "This selection cannot be used — see the panel above.";
  if (plan) return plan.summary;
  return planning ? "Checking what this will do…" : targetSummary(state, sel);
}

/** blockerFor names the first thing that makes the current selection unrunnable. */
function blockerFor(state: State, sel: Selection): string | null {
  if (state.installs.length === 0 && !sel.installDir) return "Choose the Firefox folder to act on.";
  if (!needsProfile(sel.action)) return null;
  if (sel.newProfile) {
    return sel.newProfileName !== "" && !PROFILE_NAME_RE.test(sel.newProfileName)
      ? "That profile name cannot be a folder name."
      : null;
  }
  return sel.profileDir ? null : "Choose a profile.";
}
