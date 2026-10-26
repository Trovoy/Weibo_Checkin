// No credentials are read in the page. HttpOnly cookies are read by the extension.
chrome.runtime.sendMessage({ type: 'visited' }).catch(() => {});
