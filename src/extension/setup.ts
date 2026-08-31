// The store extension's "complete the installation" page.
//
// A WebExtension cannot write files into the profile or the Firefox install
// dir, so Lazyfox ships a single native, self-contained installer binary (pure
// Go, no shell/PowerShell). This page points the user to the GitHub Releases
// download for their OS and walks them through running it. The chrome layer
// announces itself alive on window startup; until then chromeAlive is false
// and this page shows what is missing and how to finish the install.
const $ = (id: string): HTMLElement => document.getElementById(id)!;

const osName = (os: string): string => {
  if (os === "win") return "Windows";
  if (os === "mac") return "macOS";
  if (os === "linux") return "Linux";
  return os;
};

// Asset name of the standalone installer on GitHub Releases, per platform.
const ASSET: Record<string, string> = {
  win: "lazyfox-install-windows.exe",
  mac: "lazyfox-install-darwin",
  linux: "lazyfox-install-linux",
};

// The latest-release download URL for a given asset.
const releaseUrl = (asset: string): string =>
  "https://github.com/YELrhilassi/lazyfox/releases/latest/download/" + asset;

let alive = false;

const renderStatus = (): void => {
  const dot = $("dot");
  const txt = $("statusText");
  const card = $("statusCard");
  if (alive) {
    dot.className = "dot on";
    card.className = "card ok";
    txt.textContent = "Chrome layer is active — the full Lazyfox UI is installed and running.";
  } else {
    dot.className = "dot";
    card.className = "card warn";
    txt.textContent =
      "Chrome layer is not loaded — the add-on works, but the toolbar-free UI and chrome-level ; keys are missing. Follow the steps below.";
  }
};

const renderSteps = (isWin: boolean): void => {
  const steps = $("steps");
  if (isWin) {
    steps.innerHTML =
      "<li><b>Download</b> <span class='kbd'>lazyfox-install-windows.exe</span> (step 1).</li>" +
      "<li><b>Run it</b> — double-click the file.</li>" +
      "<li>If Windows shows a SmartScreen warning, click <b>More info</b> &rarr; <b>Run anyway</b> (it is a signed, open-source installer).</li>" +
      "<li>Accept the one-time <b>UAC</b> prompt (installs the autoconfig loader into the Firefox folder).</li>" +
      "<li>The installer's <b>guided wizard</b> finds your Firefox and walks you through it.</li>" +
      "<li>When it finishes, fully quit and restart Firefox.</li>";
  } else {
    steps.innerHTML =
      "<li><b>Download</b> <span class='kbd'>lazyfox-install-" +
      (navigator.platform.toLowerCase().indexOf("mac") !== -1 ? "darwin" : "linux") +
      "</span> (step 1).</li>" +
      "<li>Make it executable and <b>run</b> it in a terminal:<br>" +
      "<span class='kbd'>chmod +x ~/Downloads/lazyfox-install-*</span><br>" +
      "<span class='kbd'>~/Downloads/lazyfox-install-*</span></li>" +
      "<li>Enter your password at the one-time <b>sudo</b> prompt (installs the autoconfig loader into the Firefox folder).</li>" +
      "<li>The installer's <b>guided wizard</b> finds your Firefox and walks you through it.</li>" +
      "<li>When it finishes, fully quit and restart Firefox.</li>";
  }
};

(async () => {
  // Horizontal logo (icon + wordmark) in the header.
  try {
    const img = document.getElementById("logoImg") as HTMLImageElement;
    img.src = browser.runtime.getURL("lazyfox-logo.svg");
  } catch (e) {
    // ignore — the header works without the logo
  }

  const info = await browser.runtime.getPlatformInfo();
  const os = info.os;
  const isWin = os === "win";
  const asset: string = ASSET[os] || "lazyfox-install-linux";
  $("osName").textContent = osName(os);
  renderSteps(isWin);

  const dl = $("dl") as HTMLAnchorElement;
  dl.href = releaseUrl(asset);
  dl.textContent = "Download lazyfox-install (" + osName(os) + ")";
  $("dlNote").textContent =
    "~23 MB, fully self-contained (the chrome helper and the AMO-signed add-on are embedded). " +
    "If the download does not start, " + "<a href='" + releaseUrl(asset) + "'>click here</a>.";

  const readAlive = async (): Promise<boolean> => {
    try {
      const r = await browser.storage.local.get("chromeAlive");
      return r && r.chromeAlive === true;
    } catch (e) {
      return false;
    }
  };
  alive = await readAlive();
  renderStatus();

  browser.storage.onChanged.addListener(
    (changes: { [key: string]: { oldValue?: unknown; newValue?: unknown } }, area: string) => {
      if (area === "local" && changes.chromeAlive) {
        alive = !!changes.chromeAlive.newValue;
        renderStatus();
      }
    }
  );

  $("verify").addEventListener("click", async () => {
    const st = $("status");
    st.textContent = "checking\u2026";
    alive = await readAlive();
    renderStatus();
    st.textContent = alive
      ? "chrome layer is active \u2014 enjoy the full UI!"
      : "still not detected \u2014 did you restart Firefox after running the installer?";
  });
})();
