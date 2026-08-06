(function () {
  "use strict";

  function currentTab() {
    return browser.tabs
      .query({ active: true, currentWindow: true })
      .then((tabs) => tabs[0]);
  }

  function sendToContent(which) {
    currentTab().then((tab) => {
      if (tab) {
        browser.tabs.sendMessage(tab.id, { action: "open", which }).catch(() => {});
      }
      window.close();
    });
  }

  const handlers = {
    search: () => sendToContent("search"),
    tabs: () => sendToContent("tabs"),
    commands: () => sendToContent("commands"),
    history: () => sendToContent("history"),
    bookmarks: () => sendToContent("bookmarks"),
    downloads: () => sendToContent("downloads"),
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
      browser.tabs.create({ url: "about:preferences", active: true });
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
