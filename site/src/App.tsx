import { useState } from "react";
import {
  AMO_URL,
  INSTALL_PS,
  INSTALL_SH,
  LICENSE_URL,
  RELEASES_URL,
  REPO_URL,
  asset,
} from "./links";

const FEATURES: { key: string; title: string; body: string }[] = [
  {
    key: ";",
    title: "Command center",
    body: "New tabs open on a search box over open tabs, history, bookmarks and downloads, with quick-launch tiles for the sites you actually use.",
  },
  {
    key: ";f",
    title: "Link hints",
    body: "Every visible link, button and menu item gets a short label. Type the label to follow it.",
  },
  {
    key: ";/",
    title: "Find",
    body: "Live match count, matches in reading order, and a yank mode that copies what you found. It reads shadow roots and text split across elements.",
  },
  {
    key: ";P",
    title: "Sessions",
    body: "Named snapshots of a window, splits included. Switching replaces the whole window, and the session you are in keeps saving itself.",
  },
  {
    key: ";W",
    title: "Split view",
    body: "Two tabs side by side, both addressable from the keyboard.",
  },
  {
    key: ";R",
    title: "Reader",
    body: "The article, in place, in your typography, with the normal keys still working.",
  },
];

const KEYS: { key: string; action: string }[] = [
  { key: ";j  ;k", action: "next / previous tab" },
  { key: ";1–;9", action: "jump to a tab by position" },
  { key: ";t", action: "tab switcher" },
  { key: ";g  ;l", action: "back / forward" },
  { key: ";o  ;s", action: "open a URL / search the web" },
  { key: ";?", action: "every binding, searchable" },
];

const STEPS: { title: string; body: string }[] = [
  {
    title: "Add the add-on",
    body: "Install Lazyfox from addons.mozilla.org. It is the part that runs on pages.",
  },
  {
    title: "Run the installer",
    body: "Its home page offers the binary for your platform. It lists the profiles it found and shows what it will write before it writes it.",
  },
  {
    title: "Restart Firefox",
    body: "The tab strip and toolbar are gone. The same binary puts them back.",
  },
];

function Mark({ size = 30 }: { size?: number }) {
  return (
    <img
      className="mark"
      src={asset("lazyfox-mark.svg")}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
    />
  );
}

function Copy({ command, label }: { command: string; label: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard denied (insecure origin, or a browser that wants a gesture):
      // the command is on screen and selectable, so say nothing rather than lie.
      setCopied(false);
    }
  }

  return (
    <div className="snippet">
      <span className="snippet-label">{label}</span>
      <code>{command}</code>
      <button type="button" className="snippet-copy" onClick={copy}>
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

export default function App() {
  return (
    <>
      <a className="skip" href="#main">
        Skip to content
      </a>

      <header className="nav">
        <div className="wrap nav-inner">
          <a className="brand" href="./">
            <Mark />
            <span>Lazyfox</span>
          </a>
          <nav aria-label="Sections">
            <a href="#features">Features</a>
            <a href="#keys">Keys</a>
            <a href="#install">Install</a>
            <a href={REPO_URL} rel="noopener">
              GitHub
            </a>
          </nav>
        </div>
      </header>

      <main id="main">
        <section className="hero">
          <div className="wrap hero-inner">
            <p className="eyebrow">A Firefox for the keyboard</p>
            <h1>
              Firefox, driven
              <br className="wide" /> from the keyboard.
            </h1>
            <p className="lede">
              No tab strip, no address bar, no menus. Pages get the whole window, and one leader
              key runs everything else.
            </p>
            <div className="actions">
              <a className="button primary" href={RELEASES_URL} rel="noopener">
                Install Lazyfox
              </a>
              <a className="button" href={AMO_URL} rel="noopener">
                Add to Firefox
              </a>
            </div>
            <p className="facts">Free · MIT · No telemetry · Firefox 115+</p>

            <figure className="shot">
              <img
                src={asset("img/command-center.png")}
                width={1848}
                height={1165}
                alt="The Lazyfox command center: a search field over quick-launch tiles for Spotify, YouTube, X, GitHub, Reddit and Gmail, with no toolbar or tab strip above it."
              />
            </figure>
          </div>
        </section>

        <section id="features" className="section" aria-labelledby="features-title">
          <div className="wrap">
            <h2 id="features-title">Everything is one key away.</h2>
            <p className="sub">The key is the interface. No menus to hunt through.</p>
            <ul className="cards">
              {FEATURES.map((feature) => (
                <li key={feature.title} className="card">
                  <kbd>{feature.key}</kbd>
                  <h3>{feature.title}</h3>
                  <p>{feature.body}</p>
                </li>
              ))}
            </ul>
            <p className="also">
              Also: isolated tabs that wipe themselves when they close, dark mode per site, five
              palettes, screenshots and zoom — all behind <kbd>;</kbd>.
            </p>
          </div>
        </section>

        <section id="keys" className="section" aria-labelledby="keys-title">
          <div className="wrap split">
            <div>
              <h2 id="keys-title">One key, everything.</h2>
              <p className="sub">
                Press <kbd>;</kbd> and a grid of bindings appears over the page. Press the key for
                what you want. The grid is a reminder, never a confirmation step.
              </p>
              <ul className="keys">
                {KEYS.map((row) => (
                  <li key={row.key}>
                    <kbd>{row.key}</kbd>
                    <span>{row.action}</span>
                  </li>
                ))}
              </ul>
            </div>
            <figure className="shot side">
              <img
                src={asset("img/which-key.png")}
                width={1848}
                height={1165}
                loading="lazy"
                alt="The which-key grid open over an article: tab bindings such as n for a new tab and x to close one, with the Lazyfox status bar along the bottom of the window."
              />
            </figure>
          </div>
        </section>

        <section id="install" className="section" aria-labelledby="install-title">
          <div className="wrap">
            <h2 id="install-title">Two pieces, one run.</h2>
            <p className="sub">
              An extension cannot remove Firefox&apos;s own window, so Lazyfox ships the add-on and
              a small installer that writes the profile patch and gets out of the way.
            </p>
            <ol className="steps">
              {STEPS.map((step, index) => (
                <li key={step.title}>
                  <span className="step-number">{index + 1}</span>
                  <h3>{step.title}</h3>
                  <p>{step.body}</p>
                </li>
              ))}
            </ol>
            <div className="snippets">
              <Copy command={INSTALL_SH} label="macOS / Linux" />
              <Copy command={INSTALL_PS} label="Windows (PowerShell)" />
            </div>
            <p className="note">
              Administrator rights are needed once, for the autoconfig loader in the Firefox
              installation. Bookmarks, history, passwords and other add-ons are left alone, and
              anything replaced is backed up first.
            </p>
          </div>
        </section>
      </main>

      <footer className="footer">
        <div className="wrap footer-inner">
          <div className="brand">
            <Mark size={24} />
            <span>Lazyfox</span>
          </div>
          <p className="footer-line">Keyboard-first Firefox.</p>
          <nav aria-label="Elsewhere">
            <a href={AMO_URL} rel="noopener">
              Add-on
            </a>
            <a href={RELEASES_URL} rel="noopener">
              Releases
            </a>
            <a href={REPO_URL} rel="noopener">
              Source
            </a>
            <a href={LICENSE_URL} rel="noopener">
              MIT
            </a>
          </nav>
          <p className="footer-fine">
            Not affiliated with Mozilla. Firefox is a trademark of the Mozilla Foundation.
          </p>
        </div>
      </footer>
    </>
  );
}
