import type { ReactNode } from "react";

import { Input } from "@/components/ui/input";
import { RadioGroup } from "@/components/ui/radio-group";
import { Button } from "@/components/ui/button";
import { Choice, Toggle } from "@/components/Choice";
import { PathText } from "@/components/PathText";
import { installer } from "@/lib/installer";
import { needsProfile } from "@/lib/selection";
import { PROFILE_NAME_RE, type ProfileInfo, type Selection, type State } from "@/lib/types";

/** NEW_PROFILE is the radio value for "make me a new profile". */
const NEW_PROFILE = "__new__";

/**
 * SettingsPanel is the whole configuration surface: which Firefox, which
 * profile, and the few switches that change what gets written. It used to be a
 * separate wizard page ("Where should this happen?") reached by pressing
 * Continue, and it was laid out as a stack of cards — a card holding a radio
 * list, a second card for the name input inside the first, a third for the
 * options, each with its own rounded border and background.
 *
 * Here it is one scrolling column of labelled lists on the window's own
 * background. A section is a 11px uppercase label and a hairline-bordered list;
 * everything that is not a choice the user makes has been reduced to a single
 * muted line. The heading is the Go layer's own label and description for the
 * chosen action, so the window never restates what the installer believes it is
 * doing.
 */
export function SettingsPanel({
  state,
  sel,
  heading,
  description,
  onChange,
}: {
  state: State;
  sel: Selection;
  heading: string;
  description: string;
  onChange: (patch: Partial<Selection>) => void;
}) {
  const showProfile = needsProfile(sel.action);
  const selected = state.profiles.find((p) => p.dir === sel.profileDir);
  const nameInvalid = sel.newProfile && sel.newProfileName !== "" && !PROFILE_NAME_RE.test(sel.newProfileName);
  // On the dev channel an install always lands in a profile Lazyfox owns, so
  // there is nothing to pick — only the option of starting from a fresh one.
  const devProfile = state.devChannel && sel.action === "install";

  async function browseFirefox() {
    const dir = await installer.browseFirefoxDir().catch(() => "");
    if (dir) onChange({ installDir: dir });
  }

  return (
    <div className="flex flex-col gap-6 pb-2">
      <header>
        <h1 className="text-[15px] font-semibold leading-6">{heading}</h1>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p>
      </header>

      <Section label="Firefox">
        {state.installs.length === 0 ? (
          <Line tone="warning">
            No {state.channelShort} installation was found. Point the installer at one with Choose folder.
          </Line>
        ) : (
          <RadioGroup
            value={sel.installDir}
            onValueChange={(v) => onChange({ installDir: v })}
            className="divide-y divide-border overflow-hidden rounded-md border border-border"
          >
            {state.installs.map((fi) => (
              <Choice
                key={fi.dir}
                value={fi.dir}
                title={fi.flavor}
                code={<PathText path={fi.dir} />}
                trailing={loaderLabel(fi.loader)}
                tone={fi.loader === "outdated" ? "warning" : "muted"}
              />
            ))}
          </RadioGroup>
        )}
        <div className="mt-2">
          <Button variant="outline" size="sm" onClick={() => void browseFirefox()}>
            Choose folder…
          </Button>
        </div>
      </Section>

      {showProfile && (
        <Section label="Profile">
          {devProfile ? (
            <div className="flex flex-col gap-2">
              <Line>
                {ownedName(state) ? (
                  <>
                    Lazyfox uses its own profile here (<code className="selectable">{ownedName(state)}</code>), so
                    the {state.channelShort} profile you browse with is never modified.
                  </>
                ) : (
                  <>
                    Lazyfox creates its own profile here; the {state.channelShort} profile you browse with is never
                    modified.
                  </>
                )}
              </Line>
              <div className="divide-y divide-border overflow-hidden rounded-md border border-border">
                <Toggle
                  label="Start from a fresh profile instead"
                  meta={
                    sel.newProfileName
                      ? `Will be called ${sel.newProfileName}.`
                      : "Creates a new profile even if Lazyfox already has one."
                  }
                  checked={sel.newProfile}
                  onChange={(v) => onChange({ newProfile: v })}
                />
              </div>
              {sel.newProfile && <ProfileNameField sel={sel} invalid={nameInvalid} onChange={onChange} />}
            </div>
          ) : (
            <>
              <RadioGroup
                value={sel.newProfile ? NEW_PROFILE : sel.profileDir}
                onValueChange={(v) => {
                  if (v === NEW_PROFILE) onChange({ newProfile: true, profileDir: "" });
                  else onChange({ newProfile: false, profileDir: v });
                }}
                className="divide-y divide-border overflow-hidden rounded-md border border-border"
              >
                {state.profiles.map((p) => (
                  <ProfileChoice key={p.dir} profile={p} />
                ))}
                {sel.action === "install" && (
                  <Choice
                    value={NEW_PROFILE}
                    title="New profile"
                    meta="Lazyfox makes its own profile, so the one you browse with is untouched."
                  />
                )}
              </RadioGroup>

              {sel.newProfile && sel.action === "install" && (
                <div className="mt-2">
                  <ProfileNameField sel={sel} invalid={nameInvalid} onChange={onChange} />
                </div>
              )}

              {sel.action === "uninstall" && selected?.owned && (
                <div className="mt-2 divide-y divide-border overflow-hidden rounded-md border border-border">
                  <Toggle
                    label={`Delete this profile as well (${selected.name})`}
                    meta="Lazyfox created it, so removing it is safe. Without this the profile stays and only Lazyfox's files inside it go."
                    checked={sel.deleteProfile}
                    onChange={(v) => onChange({ deleteProfile: v })}
                  />
                </div>
              )}

              {sel.action === "uninstall" && selected && !selected.owned && (
                <div className="mt-2">
                  <Line>This is your own profile. Its folder is never deleted — only Lazyfox's files inside it.</Line>
                </div>
              )}

              {selected?.locked && (
                <div className="mt-2">
                  <Line tone="warning">
                    Firefox is using this profile now. The installer closes it first and can reopen it at the end.
                  </Line>
                </div>
              )}
            </>
          )}
        </Section>
      )}

      <Section label="Options">
        <div className="divide-y divide-border overflow-hidden rounded-md border border-border">
          {sel.action === "install" && (
            <>
              <Toggle
                label="Install the Lazyfox add-on"
                meta="The keyboard UI itself, written into the profile."
                checked={sel.useExtension}
                onChange={(v) => onChange({ useExtension: v })}
              />
              <Toggle
                label="Reopen Firefox when it is done"
                meta="Skips a manual restart at the end of the install."
                checked={sel.useLaunch}
                onChange={(v) => onChange({ useLaunch: v })}
              />
            </>
          )}
          {sel.action === "uninstall" && (
            <Toggle
              label="Remove the chrome loader too"
              meta="It lives in the Firefox folder, so this needs administrator rights."
              checked={sel.removeLoader}
              onChange={(v) => onChange({ removeLoader: v })}
            />
          )}
          {!needsProfile(sel.action) && (
            <p className="px-3 py-2.5 text-[11px] leading-4 text-muted-foreground">
              Only the loader files in the Firefox installation folder are touched — no profile is modified. This
              needs administrator rights.
            </p>
          )}
        </div>
      </Section>

      {/* Two facts about THIS BINARY, not about the user's machine: whether it
          can install an add-on at all, and — in a repo checkout — that the
          chrome layer it will write comes from dist/. The add-on always comes
          from the binary itself, so the version named here is the one the run
          will write; the old wording claimed the whole payload came from dist/,
          which stopped being true the moment the xpi became embedded. */}
      {(!state.addonAvailable || state.hasDist) && (
        <div className="flex flex-col gap-2">
          {!state.addonAvailable && (
            <Line tone="danger">
              This build carries no add-on payload, so only the chrome loader can be installed.
            </Line>
          )}
          {state.hasDist && (
            <Line>
              Repo checkout: chrome files come from <code className="selectable">dist/</code>. The add-on comes from
              this binary{state.addonVersion ? ` (lazyfox ${state.addonVersion})` : ""}.
            </Line>
          )}
        </div>
      )}
    </div>
  );
}

/** Section is a labelled group: an 11px label and a hairline, nothing more. */
function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</h2>
      {children}
    </section>
  );
}

/**
 * Line is a single statement the user cannot act on — a note, a warning, a
 * reassurance. It replaced the filled Alert box with an icon: a coloured left
 * rule carries the same "read me" weight without painting a panel, and it keeps
 * the window flat at two colours per screen instead of five.
 */
function Line({ tone = "muted", children }: { tone?: "muted" | "warning" | "danger"; children: ReactNode }) {
  const rule = tone === "danger" ? "border-destructive" : tone === "warning" ? "border-warning" : "border-border";
  const text =
    tone === "danger" ? "text-destructive" : tone === "warning" ? "text-warning" : "text-muted-foreground";
  return <p className={`border-l-2 ${rule} pl-3 text-[11px] leading-4 ${text}`}>{children}</p>;
}

function ProfileNameField({
  sel,
  invalid,
  onChange,
}: {
  sel: Selection;
  invalid: boolean;
  onChange: (patch: Partial<Selection>) => void;
}) {
  return (
    <div>
      <label htmlFor="new-profile-name" className="mb-1 block text-[11px] text-muted-foreground">
        Profile name
      </label>
      <Input
        id="new-profile-name"
        value={sel.newProfileName}
        spellCheck={false}
        autoComplete="off"
        placeholder="lazyfox-test"
        aria-invalid={invalid || undefined}
        onChange={(e) => onChange({ newProfileName: e.target.value })}
      />
      <p className={`mt-1 text-[11px] leading-4 ${invalid ? "text-destructive" : "text-muted-foreground"}`}>
        {invalid
          ? "Letters, digits, dot, dash and underscore only, starting with a letter or digit."
          : "Leave it empty and Lazyfox picks a name. Your own profile is never modified."}
      </p>
    </div>
  );
}

/**
 * ProfileChoice states a profile's facts in one muted line rather than as a row
 * of chips. Only two things earn colour: the recommendation, and a profile
 * Firefox currently holds open (which changes what is about to happen).
 */
function ProfileChoice({ profile }: { profile: ProfileInfo }) {
  const facts = [profile.edition, profile.version ? `v${profile.version}` : ""].filter(Boolean).join(" · ");
  const marks: string[] = [];
  if (profile.owned) marks.push("Lazyfox profile");
  if (profile.hasLazyfox) marks.push("Lazyfox installed");
  if (profile.isDefault) marks.push("default");

  return (
    <Choice
      value={profile.dir}
      title={profile.name}
      meta={[facts, ...marks].filter(Boolean).join("  ·  ")}
      code={<PathText path={profile.dir} />}
      trailing={profile.locked ? "in use" : profile.recommended ? "recommended" : undefined}
      tone={profile.locked ? "warning" : "primary"}
    />
  );
}

function ownedName(state: State): string {
  return state.profiles.find((p) => p.owned)?.name ?? "";
}

function loaderLabel(loader: State["installs"][number]["loader"]): string {
  switch (loader) {
    case "current":
      return "loader current";
    case "outdated":
      return "loader outdated";
    case "missing":
      return "no loader";
  }
}
