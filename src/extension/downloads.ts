// Download list and actions for the downloads popup and status bar.
//
// A thin, browser-API-only module: list the recent downloads and provide the
// three user actions (open, delete, reveal in the file manager). The status
// bar's progress/live tracking lives in the chrome helper; this module is the
// extension-background half of the download story.

export async function downloadsList() {
  const items = await browser.downloads.search({
    limit: 120,
    orderBy: ["-startTime"]
  });
  return {
    items: items.map((d: any) => {
      const path = d.filename || "";
      const state =
        d.state === "in_progress"
          ? d.paused
            ? "paused"
            : "in_progress"
          : d.state === "complete"
            ? "complete"
            : d.paused
              ? "paused"
              : "failed";
      const total = d.totalBytes || d.fileSize || 0;
      return {
        kind: "download",
        key: String(d.id),
        filename:
          (path ? path.split(/[\\/]/).pop() : "") ||
          (d.url || "").split("/").pop() ||
          d.url ||
          "",
        path: path,
        url: d.url || "",
        state: state,
        received: d.bytesReceived || 0,
        total: total,
        speed: 0,
        progress:
          total > 0
            ? Math.max(0, Math.min(100, Math.round(((d.bytesReceived || 0) / total) * 100)))
            : -1
      };
    })
  };
}

export async function openDownload(id: string) {
  const n = Number(id);
  try {
    await browser.downloads.open(n);
    return { ok: true };
  } catch (e) {
    try {
      await browser.downloads.show(n);
      return { ok: true, revealed: true };
    } catch (e2) {
      return { ok: false, error: String(e2) };
    }
  }
}

export async function removeDownload(id: string) {
  const n = Number(id);
  try {
    await browser.downloads.removeFile(n);
  } catch (e) {
    // the file may already be gone — keep going so history is cleared
  }
  try {
    await browser.downloads.erase({ id: n });
    return { ok: true };
  } catch (e2) {
    return { ok: false, error: String(e2) };
  }
}

export async function openDownloadLocation(id: string) {
  try {
    await browser.downloads.show(Number(id));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function retryDownload(id: string) {
  const n = Number(id);
  try {
    const found = await browser.downloads.search({ id: n });
    const d = found && found[0];
    if (!d || !d.url) return { ok: false, error: "download not found" };
    // Resume a paused download in place; otherwise restart from the source
    // URL as a fresh copy (never overwrite the existing file).
    if (d.state === "paused" && d.canResume) {
      await browser.downloads.resume(n);
      return { ok: true, resumed: true };
    }
    await browser.downloads.download({
      url: d.url,
      filename: d.filename ? String(d.filename).split(/[\\/]/).pop() : undefined,
      conflictAction: "uniquify",
      saveAs: false,
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
