(function () {
  "use strict";

  function sendToBackground(which) {
    browser.runtime.sendMessage({ action: "openUI", data: { which: which } }).catch(() => {});
    window.close();
  }

  const handlers = {
    search: () => sendToBackground("search"),
    tabs: () => sendToBackground("tabs"),
    commands: () => sendToBackground("commands"),
    history: () => sendToBackground("history"),
    bookmarks: () => sendToBackground("bookmarks"),
    downloads: () => sendToBackground("downloads"),
    universal: () => {
      if (browser.sidebarAction && browser.sidebarAction.toggle) {
        browser.sidebarAction.toggle().catch(() => {
          browser.runtime.sendMessage({ action: "toggleSidebar", data: {} });
        });
      } else {
        browser.runtime.sendMessage({ action: "toggleSidebar", data: {} });
      }
      window.close();
    },
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
      const fn = handlers[which];
      if (fn) fn();
    });
  });
})();
