import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Loader2Icon, TriangleAlertIcon } from "lucide-react";

import { ActionStep } from "@/components/ActionStep";
import { ReviewStep } from "@/components/ReviewStep";
import { RunStep } from "@/components/RunStep";
import { StepRail } from "@/components/StepRail";
import { TargetStep } from "@/components/TargetStep";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { installer, onStep } from "@/lib/installer";
import { actionVerb, initialSelection, needsProfile, resetForAction, targetSummary, toRequest } from "@/lib/selection";
import {
  PROFILE_NAME_RE,
  type ActionId,
  type Preview,
  type Result,
  type Selection,
  type State,
  type Step,
} from "@/lib/types";

type Phase = 0 | 1 | 2 | 3;

const PHASE_NAMES: Record<Phase, string> = {
  0: "Action",
  1: "Target",
  2: "Review",
  3: "Run",
};

/**
 * App owns the flow (action → target → review → run) and nothing else. Every
 * fact about the machine comes from the Go layer and every action goes back to
 * it, so the window can be redesigned without changing what the installer does.
 */
export function App() {
  const [state, setState] = useState<State | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>(0);
  const [sel, setSel] = useState<Selection | null>(null);

  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  const [steps, setSteps] = useState<Step[]>([]);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<Result | null>(null);

  // The profile name a preview promised. Held so the run creates exactly the
  // folder the user reviewed, not a freshly generated one.
  const pinnedName = useRef("");

  useEffect(() => {
    let cancelled = false;
    installer
      .state()
      .then((st) => {
        if (cancelled) return;
        setState(st);
        setSel(initialSelection(st, "install"));
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

  const update = useCallback((patch: Partial<Selection>) => {
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
      setPreview(null);
      setRunError(null);
    },
    [state],
  );

  const canContinue = useMemo(() => {
    if (!state || !sel) return false;
    if (phase === 0) return state.installs.length > 0 || sel.installDir !== "";
    if (phase === 1) {
      if (state.installs.length === 0 && !sel.installDir) return false;
      if (!needsProfile(sel.action)) return true;
      if (sel.action === "install" && sel.newProfile) {
        return sel.newProfileName === "" || PROFILE_NAME_RE.test(sel.newProfileName);
      }
      return sel.profileDir !== "";
    }
    return phase === 2 && preview !== null;
  }, [state, sel, phase, preview]);

  /** loadPreview resolves the selection so the review can show exactly what it does. */
  async function loadPreview(next: Selection) {
    setBusy(true);
    setRunError(null);
    try {
      // Send the pinned name so re-taking a preview for the same plan shows the
      // same folder rather than a fresh random one.
      const pv = await installer.preview(toRequest(next, pinnedName.current));
      if (pv.createsProfile && pv.profile?.name) pinnedName.current = pv.profile.name;
      setPreview(pv);
      setPhase(2);
    } catch (err) {
      // A refused selection is shown where it can be fixed rather than as a
      // dead end on the review screen.
      setPreview(null);
      setRunError((err as Error).message);
      setPhase(1);
    } finally {
      setBusy(false);
    }
  }

  async function run() {
    if (!sel) return;
    setRunning(true);
    setResult(null);
    setSteps([]);
    setPhase(3);
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
    setPreview(null);
    setResult(null);
    setSteps([]);
    setRunError(null);
    setPhase(0);
    try {
      const st = await installer.state();
      setState(st);
      setSel(initialSelection(st, "install"));
    } catch (err) {
      setFatal((err as Error).message);
    }
  }

  if (fatal) {
    return (
      <Shell>
        <Alert variant="danger">
          <TriangleAlertIcon />
          <AlertDescription>
            <p className="font-medium">The installer could not start.</p>
            <p className="mt-1 whitespace-pre-wrap">{fatal}</p>
          </AlertDescription>
        </Alert>
      </Shell>
    );
  }

  if (!state || !sel) {
    return (
      <Shell>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2Icon className="size-3.5 animate-spin" />
          Looking for Firefox…
        </div>
      </Shell>
    );
  }

  return (
    <Shell
      channel={state.channelShort}
      rail={<StepRail current={phase} finished={phase === 3 && result?.ok === true} />}
      footer={
        phase < 3 ? (
          <Footer
            label={PHASE_NAMES[phase]}
            summary={phase === 2 ? preview?.summary : phase === 1 ? targetSummary(state, sel) : state.profilePolicy}
            onBack={phase === 0 ? undefined : () => setPhase((phase - 1) as Phase)}
            primaryLabel={phase === 2 ? actionVerb(sel.action) : "Continue"}
            primaryVariant={phase === 2 && sel.action === "uninstall" ? "destructive" : "default"}
            busy={busy}
            disabled={!canContinue}
            onPrimary={() => {
              if (phase === 0) setPhase(1);
              else if (phase === 1) void loadPreview(sel);
              else void run();
            }}
          />
        ) : undefined
      }
    >
      {runError && phase === 1 && (
        <Alert variant="danger" className="mb-4 shrink-0">
          <TriangleAlertIcon />
          <AlertDescription className="whitespace-pre-wrap">{runError}</AlertDescription>
        </Alert>
      )}
      {phase === 0 && <ActionStep state={state} action={sel.action} onAction={onAction} />}
      {phase === 1 && <TargetStep state={state} sel={sel} onChange={update} />}
      {phase === 2 && preview && <ReviewStep preview={preview} />}
      {phase === 3 && (
        <RunStep
          preview={preview}
          steps={steps}
          running={running}
          result={result}
          onDone={() => installer.quit()}
          onStartOver={startOver}
        />
      )}
    </Shell>
  );
}

/** Shell is the window frame: header, step rail, panel and footer. */
function Shell({ channel, rail, footer, children }: { channel?: string; rail?: ReactNode; footer?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-5 py-3">
        <span className="text-sm font-semibold tracking-tight">Lazyfox</span>
        <span className="text-xs text-muted-foreground">installer</span>
        {rail && <div className="ml-3">{rail}</div>}
        {channel && <span className="ml-auto text-[11px] text-muted-foreground">{channel}</span>}
      </header>

      <main className="flex min-h-0 flex-1 flex-col overflow-auto px-5 py-5">{children}</main>

      {footer ? <div className="shrink-0 border-t border-border px-5 py-3">{footer}</div> : null}
    </div>
  );
}

function Footer({
  summary,
  onBack,
  primaryLabel,
  primaryVariant,
  onPrimary,
  disabled,
  busy,
}: {
  label: string;
  summary?: string;
  onBack?: () => void;
  primaryLabel: string;
  primaryVariant: "default" | "destructive";
  onPrimary: () => void;
  disabled: boolean;
  busy: boolean;
}) {
  return (
    <div className="flex items-center gap-3">
      <p className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground" title={summary}>
        {summary}
      </p>
      {onBack && (
        <Button variant="outline" size="sm" disabled={busy} onClick={onBack}>
          Back
        </Button>
      )}
      <Button size="sm" variant={primaryVariant} disabled={disabled || busy} onClick={onPrimary}>
        {busy && <Loader2Icon className="animate-spin" />}
        {primaryLabel}
      </Button>
    </div>
  );
}
