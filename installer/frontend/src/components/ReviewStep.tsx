import type { ReactNode } from "react";
import { AlertTriangleIcon, FileIcon, FolderIcon, InfoIcon, ShieldCheckIcon } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PathText } from "@/components/PathText";
import { cn } from "@/lib/utils";
import type { Preview } from "@/lib/types";

/**
 * ReviewStep is the promise the installer makes before it touches anything.
 *
 * For an install that is a list of everything it will write. For an uninstall it
 * is the list the user is owed: every file that goes, and every thing that
 * stays — including their own profile and the browsing data inside it, which
 * Lazyfox never removes.
 */
export function ReviewStep({ preview }: { preview: Preview }) {
  const removals = preview.removals ?? [];
  const unchanged = preview.unchanged ?? [];
  const changes = preview.changes ?? [];
  const isUninstall = preview.action === "uninstall";

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-base font-semibold">{isUninstall ? "What will be removed" : "What will be installed"}</h1>
        <p className="mt-1 text-xs text-muted-foreground">{preview.summary}</p>
      </div>

      {preview.createsProfile && !isUninstall && (
        <Card className="border-primary/35 bg-primary/5">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-primary">
              <FolderIcon className="size-4" />
              A new profile&apos;s name is fixed before anything is written
            </CardTitle>
          </CardHeader>
          <CardContent>
            <PathText path={preview.profile.dir} wrap />
            <p className="mt-2 text-xs text-muted-foreground">
              {preview.profile.name} is registered with Firefox and made its default for this install. Your own
              profile is not opened, modified or deleted.
            </p>
          </CardContent>
        </Card>
      )}

      {isUninstall ? (
        <>
          <ItemList
            title={removals.length ? `Files Lazyfox will remove (${removals.length})` : "Nothing to remove"}
            tone="destructive"
            empty="Lazyfox does not look installed in this profile."
            items={removals.map((r) => ({
              key: r.path,
              icon: r.kind === "profile" ? <FolderIcon className="size-4" /> : <FileIcon className="size-4" />,
              title: r.detail,
              path: r.path,
              tags: [r.owned && { label: "Lazyfox profile", variant: "brand" as const }],
            }))}
            note={
              removals.some((r) => r.restorable)
                ? "Every file above is copied to a timestamped .lazyfox.uninst.bak backup beside it before it is removed."
                : undefined
            }
          />
          <ItemList
            title="Left alone"
            tone="safe"
            items={unchanged.map((r) => ({
              key: r.path,
              icon: r.kind === "profile" ? <ShieldCheckIcon className="size-4" /> : <FileIcon className="size-4" />,
              title: r.detail,
              path: r.path,
              tags: r.kind === "profile" ? [{ label: "never deleted", variant: "success" as const }] : [],
            }))}
          />
          {preview.deletesProfile && (
            <Alert variant="danger">
              <AlertTriangleIcon />
              <AlertDescription>
                The whole profile folder goes with it, because Lazyfox created it. Everything else — your bookmarks,
                history, saved logins and other add-ons — lives in profiles Lazyfox never touches.
              </AlertDescription>
            </Alert>
          )}
        </>
      ) : (
        <ItemList
          title={`What will be written (${changes.length})`}
          items={changes.map((c) => ({
            key: c.path,
            icon: c.kind === "profile" ? <FolderIcon className="size-4" /> : <FileIcon className="size-4" />,
            title: c.detail,
            path: c.path,
            tags: [
              c.elevated && { label: "needs admin", variant: "warning" as const },
              c.optional && { label: "optional", variant: "outline" as const },
            ],
          }))}
        />
      )}

      {(preview.warnings ?? []).map((w) => (
        <Alert key={w} variant="warning">
          <AlertTriangleIcon />
          <AlertDescription>{w}</AlertDescription>
        </Alert>
      ))}

      {preview.needsAdmin && (
        <Alert>
          <InfoIcon />
          <AlertDescription>
            One step writes into the Firefox installation folder, which needs administrator rights. Your system shows
            its own prompt for that step and nothing else.
          </AlertDescription>
        </Alert>
      )}

      {isUninstall && !preview.needsAdmin && (
        <Alert>
          <InfoIcon />
          <AlertDescription>Nothing here needs administrator rights.</AlertDescription>
        </Alert>
      )}
    </div>
  );
}

type ListItem = {
  key: string;
  icon: ReactNode;
  title: string;
  path: string;
  tags: (false | { label: string; variant: "brand" | "success" | "warning" | "outline" })[];
};

function ItemList({
  title,
  items,
  tone,
  empty,
  note,
}: {
  title: string;
  items: ListItem[];
  tone?: "destructive" | "safe";
  empty?: string;
  note?: string;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</h2>
      {items.length === 0 ? (
        <p className="rounded-xl border border-border bg-card px-4 py-3 text-xs text-muted-foreground">{empty}</p>
      ) : (
        <ul className="flex flex-col overflow-hidden rounded-xl border border-border bg-card">
          {items.map((item) => (
            <li key={item.key} className="flex items-start gap-3 border-b border-border px-4 py-3 last:border-b-0">
              <span
                className={cn(
                  "mt-0.5 shrink-0",
                  tone === "destructive" ? "text-destructive" : tone === "safe" ? "text-success" : "text-muted-foreground",
                )}
              >
                {item.icon}
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-xs font-medium leading-5">{item.title}</span>
                <PathText path={item.path} wrap />
              </span>
              <span className="flex shrink-0 flex-wrap justify-end gap-1 pt-0.5">
                {item.tags.map(
                  (t) => t && <Badge key={t.label} variant={t.variant}>{t.label}</Badge>,
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {note && items.length > 0 && <p className="px-1 text-[11px] leading-5 text-muted-foreground">{note}</p>}
    </section>
  );
}
