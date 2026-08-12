// Browser-action popup: sends an "openUI" request to the background so the
// popups appear in the chrome helper (which can render them on about:/error
// pages too). Plain web-ext page, no core needed.

(function () {
  "use strict";

  function sendToBackground(which: string) {
    browser.runtime.sendMessage({ action: "openUI", data: { which: which } }).catch(() => {});
    window.close();
  }

  const handlers: { [k: string]: () => void } = {
    search: () => sendToBackground("search"),
    tabs: () => sendToBackground("tabs"),
    history: () => sendToBackground("history"),
    bookmarks: () => sendToBackground("bookmarks"),
    downloads: () => sendToBackground("downloads"),
    settings: () => {
      browser.runtime.sendMessage({ action: "openPage", data: { url: "about:preferences" } });
      window.close();
    },
    zen: () => {
      browser.runtime.sendMessage({ action: "zen", data: {} });
      window.close();
    },
    options: () => {
      browser.runtime.openOptionsPage();
      window.close();
    }
  };

  document.querySelectorAll(".item[data-open]").forEach((el) => {
    el.addEventListener("click", () => {
      const which = el.getAttribute("data-open");
      const fn = handlers[which as string];
      if (fn) fn();
    });
  });
})();
