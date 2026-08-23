// The store extension's "complete the installation" page. A WebExtension
// cannot write files into the profile or the Firefox install dir, so this page
// hands the user a self-contained patcher (built into the package as
// patch/install.ps1 / patch/install.sh with the chrome helper payload embedded)
// and guides them through running it. The chrome layer announces itself alive
// on window startup; until then, chromeAlive is false and this page shows what
// is missing and how to finish the install.
const $ = (id: string): HTMLElement => document.getElementById(id)!;

const osName = (os: string): string => {
  if (os === "win") return "Windows";
  if (os === "mac") return "macOS";
  if (os === "linux") return "Linux";
  return os;
};

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
  const file = isWin ? "lazyfox-install.ps1" : "lazyfox-install.sh";
  if (isWin) {
    steps.innerHTML =
      "<li>Downloaded as <b>" + file + "</b> (your Downloads folder).</li>" +
      "<li>Right-click it &rarr; <b>Run with PowerShell</b>.</li>" +
      "<li>If Windows blocks it: right-click &rarr; <b>Properties</b> &rarr; tick <b>Unblock</b> &rarr; OK, then run again.</li>" +
      "<li>Accept the one-time <b>UAC</b> prompt (installs the autoconfig loader into the Firefox folder).</li>" +
      "<li>When it prints <b>Done</b>, fully quit and restart Firefox.</li>";
  } else {
    steps.innerHTML =
      "<li>Downloaded as <b>" + file + "</b> (your Downloads folder).</li>" +
      "<li>Open a terminal and run:<br><span class='kbd'>bash ~/Downloads/" + file + "</span></li>" +
      "<li>Enter your password at the one-time <b>sudo</b> prompt (installs the autoconfig loader into the Firefox folder).</li>" +
      "<li>When it prints <b>Done</b>, fully quit and restart Firefox.</li>";
  }
};

(async () => {
  const isWin = (await browser.runtime.getPlatformInfo()).os === "win";
  $("osName").textContent = osName((await browser.runtime.getPlatformInfo()).os);
  renderSteps(isWin);
  $("dlNote").textContent =
    "~11 MB, fully self-contained (the chrome helper is embedded). If the download does not start, " +
    "<a href='" + browser.runtime.getURL("patch/" + (isWin ? "install.ps1" : "install.sh")) + "'>click here</a>.";

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

  $("dl").addEventListener("click", async () => {
    const file = isWin ? "install.ps1" : "install.sh";
    const st = $("status");
    st.textContent = "downloading\u2026";
    try {
      await browser.downloads.download({
        url: browser.runtime.getURL("patch/" + file),
        filename: "lazyfox-install." + (isWin ? "ps1" : "sh"),
        saveAs: false,
      });
      st.textContent = "downloaded \u2014 now run it (step 2)";
    } catch (e) {
      st.textContent = "download failed \u2014 use the direct link below";
    }
  });

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
