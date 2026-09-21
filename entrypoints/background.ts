export default defineBackground(() => {
  // Nothing runs in the background yet. Reminders (chrome.alarms + notifications) will live here.
  browser.runtime.onInstalled.addListener(({ reason }) => {
    if (reason === 'install') console.log('[fogar] installed');
  });
});
