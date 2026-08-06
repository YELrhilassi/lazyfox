(function () {
  "use strict";

  const leader = document.getElementById("leader");
  const hintChars = document.getElementById("hintChars");
  const scrollKeys = document.getElementById("scrollKeys");
  const openInNewTab = document.getElementById("openInNewTab");
  const saveBtn = document.getElementById("save");
  const statusEl = document.getElementById("status");

  browser.storage.local.get("config").then((r) => {
    const c = Object.assign(
      { leader: ";", hintChars: "asdfjkl;gh", scrollKeys: true, openInNewTab: true },
      r.config || {}
    );
    leader.value = c.leader;
    hintChars.value = c.hintChars;
    scrollKeys.checked = c.scrollKeys !== false;
    openInNewTab.checked = c.openInNewTab !== false;
  });

  saveBtn.addEventListener("click", () => {
    browser.storage.local
      .set({
        config: {
          leader: leader.value || ";",
          hintChars: hintChars.value || "asdfjkl;gh",
          scrollKeys: scrollKeys.checked,
          openInNewTab: openInNewTab.checked
        }
      })
      .then(() => {
        statusEl.textContent = "saved";
        setTimeout(() => (statusEl.textContent = ""), 1500);
      });
  });
})();
