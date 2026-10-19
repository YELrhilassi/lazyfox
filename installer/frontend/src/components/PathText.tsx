import { cn } from "@/lib/utils";
import { shortenPath } from "@/lib/format";

/**
 * PathText shows a filesystem path: shortened to its last few segments so long
 * Windows and macOS paths never wrap, with the full path in the tooltip and
 * selectable for copy. `wrap` renders it whole instead, which is what the
 * removal review uses — there, the exact file matters more than the row height.
 */
export function PathText({
  path,
  keep = 3,
  wrap = false,
  className,
}: {
  path: string;
  keep?: number;
  wrap?: boolean;
  className?: string;
}) {
  if (!path) return null;
  return (
    <span
      title={path}
      className={cn(
        "selectable font-mono text-[11px] leading-5 text-muted-foreground",
        wrap ? "break-all" : "block truncate",
        className,
      )}
    >
      {wrap ? path : shortenPath(path, keep)}
    </span>
  );
}
