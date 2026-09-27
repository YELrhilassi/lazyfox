import { useEffect, useRef } from "react";
import { AlertTriangleIcon, CheckCircle2Icon, Loader2Icon, XCircleIcon } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { PathText } from "@/components/PathText";
import type { Preview, Result, Step } from "@/lib/types";

/**
 * RunStep shows the operation happening — the same step lines the CLI prints —
 * and then the outcome, including the one thing that is easy to get wrong:
 * whether Firefox still has to be started once before the add-on appears.
 */
export function RunStep({
  preview,
  steps,
  running,
  result,
  onDone,
  onStartOver,
}: {
  preview: Preview | null;
  steps: Step[];
  running: boolean;
  result: Result | null;
  onDone: () => void;
  onStartOver: () => void;
}) {
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [steps.length, result]);

  const failures = result?.failures ?? [];

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      {preview && (
        <div className="shrink-0">
          <h1 className="text-base font-semibold">{preview.summary}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              {running ? (
                <>
                  <Loader2Icon className="size-3.5 animate-spin text-primary" />
                  Working…
                </>
              ) : result?.ok ? (
                <>
                  <CheckCircle2Icon className="size-3.5 text-success" />
                  Done
                </>
              ) : result ? (
                <>
                  <XCircleIcon className="size-3.5 text-destructive" />
                  Stopped
                </>
              ) : (
                "Ready"
              )}
            </span>
            {preview.profile.dir && (
              <>
                <span aria-hidden>·</span>
                <PathText path={preview.profile.dir} keep={2} className="max-w-[22rem]" />
              </>
            )}
          </div>
        </div>
      )}

      <div
        ref={logRef}
        className="min-h-32 flex-1 overflow-auto rounded-xl border border-border bg-black/35 p-3 font-mono text-[11px] leading-relaxed"
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
        <Alert variant={result.ok ? "success" : "danger"} className="shrink-0">
          {result.ok ? <CheckCircle2Icon /> : <AlertTriangleIcon />}
          <AlertDescription className="text-current">
            <p className="font-medium">{result.text}</p>
            {result.ok && result.state === "installed" && (
              <p className="mt-1 text-muted-foreground">
                {result.pendingEnable
                  ? "Start Firefox once and the add-on loads with it. Then press ; on any page."
                  : "Press ; on any page to open the command overlay."}
              </p>
            )}
            {failures.length > 0 && (
              <ul className="mt-1 list-disc pl-4 text-muted-foreground">
                {failures.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            )}
          </AlertDescription>
        </Alert>
      )}

      {!running && (
        <div className="flex shrink-0 gap-2">
          <Button variant="outline" onClick={onStartOver}>
            Back to the start
          </Button>
          <Button onClick={onDone}>Close</Button>
        </div>
      )}
    </div>
  );
}
