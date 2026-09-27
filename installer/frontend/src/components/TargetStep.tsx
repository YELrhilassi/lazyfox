import { FolderSearchIcon, ShieldCheckIcon, SparklesIcon } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { RadioGroup } from "@/components/ui/radio-group";
import { PickRow } from "@/components/PickRow";
import { PathText } from "@/components/PathText";
import { installer } from "@/lib/installer";
import { PROFILE_NAME_RE, type ProfileInfo, type Selection, type State } from "@/lib/types";
import { needsProfile } from "@/lib/selection";

/** NEW_PROFILE is the radio value for "make me a new profile". */
const NEW_PROFILE = "__new__";

/**
 * TargetStep is where the user says what to act on: which Firefox, and — the
 * question that matters — whether to use a profile they already have or to let
 * Lazyfox create one of its own.
 */
export function TargetStep({
  state,
  sel,
  onChange,
}: {
  state: State;
  sel: Selection;
  onChange: (patch: Partial<Selection>) => void;
}) {
  const showProfile = needsProfile(sel.action);
  const profileValue = sel.newProfile ? NEW_PROFILE : sel.profileDir;
  const selected = state.profiles.find((p) => p.dir === sel.profileDir);
  const nameError = sel.newProfileName && !PROFILE_NAME_RE.test(sel.newProfileName);

  async function browseFirefox() {
    const dir = await installer.browseFirefoxDir().catch(() => "");
    if (dir) onChange({ installDir: dir });
  }

  return (
    <div className="flex flex-col gap-5">
      <h1 className="text-base font-semibold">Where should this happen?</h1>

      <section className="flex flex-col gap-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Firefox installation
        </h2>
        {state.installs.length === 0 ? (
          <Alert variant="warning">
            <AlertDescription>No {state.channelShort} installation was detected.</AlertDescription>
          </Alert>
        ) : (
          <RadioGroup
            value={sel.installDir}
            onValueChange={(v) => onChange({ installDir: v })}
            className="gap-0 overflow-hidden rounded-xl border border-border bg-card"
          >
            {state.installs.map((fi) => (
              <PickRow
                key={fi.dir}
                value={fi.dir}
                title={fi.flavor}
                code={<PathText path={fi.dir} />}
                meta={
                  <>
                    {fi.loader === "current" && <Badge variant="success">loader current</Badge>}
                    {fi.loader === "outdated" && <Badge variant="warning">loader outdated</Badge>}
                    {fi.loader === "missing" && <Badge variant="outline">no loader</Badge>}
                  </>
                }
              />
            ))}
          </RadioGroup>
        )}
        <Button variant="outline" size="sm" className="self-start" onClick={browseFirefox}>
          <FolderSearchIcon />
          Choose a folder…
        </Button>
      </section>

      {showProfile && (
        <section className="flex flex-col gap-2">
          <h2 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Profile</h2>

          {state.devChannel && sel.action === "install" ? (
            <DevProfileChoice state={state} sel={sel} onChange={onChange} />
          ) : (
            <RadioGroup
              value={profileValue}
              onValueChange={(v) => {
                if (v === NEW_PROFILE) onChange({ newProfile: true, profileDir: "" });
                else onChange({ newProfile: false, profileDir: v });
              }}
              className="gap-0 overflow-hidden rounded-xl border border-border bg-card"
            >
              {state.profiles.map((p) => (
                <ProfileRow key={p.dir} profile={p} />
              ))}
              {sel.action === "install" && (
                <PickRow
                  value={NEW_PROFILE}
                  title={
                    <span className="flex items-center gap-1.5">
                      <SparklesIcon className="size-3.5 text-primary" />
                      Create a new profile
                    </span>
                  }
                  hint="Lazyfox makes its own profile and leaves the one you browse with untouched."
                />
              )}
            </RadioGroup>
          )}

          {sel.newProfile && sel.action === "install" && (
            <div className="flex flex-col gap-1.5 rounded-xl border border-border bg-card p-4">
              <label htmlFor="new-profile-name" className="text-xs font-medium">
                Name for the new profile
              </label>
              <Input
                id="new-profile-name"
                value={sel.newProfileName}
                spellCheck={false}
                autoComplete="off"
                placeholder="lazyfox-test"
                onChange={(e) => onChange({ newProfileName: e.target.value })}
              />
              {nameError ? (
                <p className="text-[11px] text-destructive">
                  Letters, digits, dot, dash and underscore only, starting with a letter or digit.
                </p>
              ) : (
                <p className="text-[11px] text-muted-foreground">
                  Leave it empty and Lazyfox picks a name. Your own profile is never modified.
                </p>
              )}
            </div>
          )}

          {sel.action === "uninstall" && selected?.owned && (
            <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-border bg-card p-4">
              <Checkbox
                checked={sel.deleteProfile}
                onCheckedChange={(v) => onChange({ deleteProfile: v === true })}
                className="mt-0.5"
              />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-sm font-medium">
                  Delete this profile as well ({selected.name})
                </span>
                <span className="text-xs leading-5 text-muted-foreground">
                  Lazyfox created it, so removing it is safe. Without this, the profile stays and only
                  Lazyfox's files inside it go.
                </span>
              </span>
            </label>
          )}

          {sel.action === "uninstall" && !selected?.owned && selected && (
            <Alert>
              <ShieldCheckIcon />
              <AlertDescription>
                This is your own profile. Its folder is never deleted — only Lazyfox's files inside it.
              </AlertDescription>
            </Alert>
          )}

          {selected?.locked && (
            <p className="text-[11px] text-warning">
              Firefox is using this profile now; the installer closes it first and can reopen it at the end.
            </p>
          )}
        </section>
      )}

      <section className="flex flex-col gap-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Options</h2>
        <div className="flex flex-col overflow-hidden rounded-xl border border-border bg-card">
          {sel.action === "install" && (
            <>
              <ToggleRow
                label="Install the Lazyfox add-on"
                hint="The keyboard UI itself, written into the profile."
                checked={sel.useExtension}
                onChange={(v) => onChange({ useExtension: v })}
              />
              <ToggleRow
                label="Reopen Firefox when it is done"
                hint="Skips a manual restart at the end of the install."
                checked={sel.useLaunch}
                onChange={(v) => onChange({ useLaunch: v })}
              />
            </>
          )}
          {sel.action === "uninstall" && (
            <ToggleRow
              label="Remove the chrome loader too"
              hint="It lives in the Firefox folder, so this needs administrator rights."
              checked={sel.removeLoader}
              onChange={(v) => onChange({ removeLoader: v })}
            />
          )}
          {(sel.action === "loader-only" || sel.action === "loader-remove") && (
            <p className="p-4 text-xs text-muted-foreground">
              Only the loader files in the Firefox installation folder are touched — no profile is modified.
              This step needs administrator rights.
            </p>
          )}
        </div>
      </section>
    </div>
  );
}

/**
 * DevProfileChoice is the Developer Edition / Nightly case: the channel's policy
 * is always its own disposable profile, so there is no profile to pick — only
 * the option to start from a fresh one.
 */
function DevProfileChoice({
  state,
  sel,
  onChange,
}: {
  state: State;
  sel: Selection;
  onChange: (patch: Partial<Selection>) => void;
}) {
  const owned = state.profiles.filter((p) => p.owned);
  return (
    <div className="flex flex-col gap-2">
      <Alert>
        <SparklesIcon />
        <AlertDescription>
          {owned.length > 0 ? (
            <>
              Lazyfox uses its own profile here (<code className="selectable">{owned[0]?.name}</code>), so the
              Developer Edition profile you browse with is never modified.
            </>
          ) : (
            <>
              Lazyfox creates its own <code className="selectable">dev-&lt;id&gt;</code> profile here; the
              Developer Edition profile you browse with is never modified.
            </>
          )}
        </AlertDescription>
      </Alert>
      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <ToggleRow
          label="Start from a fresh profile instead"
          hint={sel.newProfileName ? `Will be called ${sel.newProfileName}.` : "Creates a new profile even if Lazyfox already has one."}
          checked={sel.newProfile}
          onChange={(v) => onChange({ newProfile: v })}
        />
        {sel.newProfile && (
          <div className="flex flex-col gap-1.5 border-t border-border px-4 py-3">
            <Input
              value={sel.newProfileName}
              spellCheck={false}
              autoComplete="off"
              placeholder="dev-lazyfox"
              onChange={(e) => onChange({ newProfileName: e.target.value })}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function ProfileRow({ profile }: { profile: ProfileInfo }) {
  // The edition and version, not the pre-joined label: the label repeats the
  // name and spells out the same marks the badges show next to it.
  const edition = [profile.edition, profile.version ? `v${profile.version}` : ""].filter(Boolean).join(" · ");
  return (
    <PickRow
      value={profile.dir}
      title={profile.name}
      hint={
        <span className="flex flex-wrap items-center gap-1.5">
          {edition}
          {profile.recommended && <Badge variant="brand">recommended</Badge>}
          {profile.locked && <Badge variant="danger">in use</Badge>}
          {profile.hasLazyfox && <Badge variant="success">Lazyfox installed</Badge>}
          {profile.owned && <Badge variant="outline">Lazyfox profile</Badge>}
          {profile.isDefault && <Badge variant="outline">default</Badge>}
        </span>
      }
      code={<PathText path={profile.dir} />}
    />
  );
}

function ToggleRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 border-b border-border px-4 py-3 last:border-b-0 hover:bg-accent/60">
      <Checkbox checked={checked} onCheckedChange={(v) => onChange(v === true)} className="mt-0.5" />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm font-medium">{label}</span>
        <span className="text-xs leading-5 text-muted-foreground">{hint}</span>
      </span>
    </label>
  );
}
