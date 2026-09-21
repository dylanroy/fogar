export default defineBackground(() => {
  browser.runtime.onInstalled.addListener(() => {
    browser.contextMenus.create({
      id: 'fogar-ask',
      title: 'Ask Fogar about “%s”',
      contexts: ['selection'],
    });
  });

  browser.contextMenus.onClicked.addListener((info) => {
    if (info.menuItemId !== 'fogar-ask' || !info.selectionText) return;
    const url = browser.runtime.getURL(`/newtab.html?q=${encodeURIComponent(info.selectionText)}`);
    void browser.tabs.create({ url });
  });

  // Reminders (chrome.alarms + notifications) will live here in Phase 3.
});
