import { AlertTriangleIcon, InfoIcon } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { RadioGroup } from "@/components/ui/radio-group";
import { PickRow } from "@/components/PickRow";
import type { ActionId, State } from "@/lib/types";

/** ActionStep picks what the installer should do. */
export function ActionStep({
  state,
  action,
  onAction,
}: {
  state: State;
  action: ActionId;
  onAction: (id: ActionId) => void;
}) {
  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-base font-semibold">What would you like to do?</h1>
        <p className="mt-1 text-xs text-muted-foreground">
          {action === "install" ? state.profilePolicy : `This build handles ${state.channelLabel} only.`}
        </p>
      </div>

      <RadioGroup value={action} onValueChange={(v) => onAction(v as ActionId)} className="gap-0 overflow-hidden rounded-xl border border-border bg-card">
        {state.actions.map((a) => (
          <PickRow key={a.id} value={a.id} title={a.label} hint={a.desc} />
        ))}
      </RadioGroup>

      {state.installs.length === 0 && (
        <Alert variant="warning">
          <AlertTriangleIcon />
          <AlertDescription>
            No {state.channelShort} installation was found, so there is nothing to act on. Install{" "}
            {state.channelShort} first, or point the installer at it on the next step.
          </AlertDescription>
        </Alert>
      )}
      {!state.addonAvailable && (
        <Alert variant="warning">
          <AlertTriangleIcon />
          <AlertDescription>
            This build carries no add-on payload, so only the chrome loader can be installed.
          </AlertDescription>
        </Alert>
      )}
      {state.hasDist && (
        <Alert>
          <InfoIcon />
          <AlertDescription>
            Working from a repo checkout: the installer is using <code className="selectable">dist/</code> instead of its
            embedded payload.
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}
