// Browser-action popup: asks the background to open one of the chrome
// helper's popups, so they appear over about:/error pages too (the content
// script cannot run there). Plain web-ext page, no core needed.
//
// The messages go through the typed `send()` helper rather than hand-rolled
// runtime.sendMessage calls. This file used to build its own message objects,
// which meant the one place a user clicks first was the one place the protocol
// contract was not checked: a renamed action or a changed payload compiled
// fine here and failed only when the button was pressed.
import { send } from "../shared/protocol";

(function () {
  "use strict";

  function openUI(which: string): void {
    void send("openUI", { which: which });
    window.close();
  }

  const handlers: { [k: string]: () => void } = {
    search: () => openUI("search"),
    tabs: () => openUI("tabs"),
    history: () => openUI("history"),
    bookmarks: () => openUI("bookmarks"),
    downloads: () => openUI("downloads"),
    settings: () => {
      void send("openPage", { url: "about:preferences" });
      window.close();
    },
    zen: () => {
      void send("zen");
      window.close();
    },
    options: () => {
      void browser.runtime.openOptionsPage();
      window.close();
    },
  };

  document.querySelectorAll(".item[data-open]").forEach((el) => {
    el.addEventListener("click", () => {
      const which = el.getAttribute("data-open");
      const fn = handlers[which as string];
      if (fn) fn();
    });
  });
})();
