// Safari has no identity.launchWebAuthFlow, so on iOS the GitHub sign-in opens
// https://spacegho.st/melodica/auth/start in a tab with return_to set to the web
// app (the only https return_to the auth Worker accepts besides the browsers'
// identity hosts). The Worker sends the tab back to /melodica/app/#melodica_token=…;
// this script (document_start, before the page reads the fragment) hands the token
// to the background, which keeps it only if it opened that sign-in tab itself.
(() => {
  const m = /[#&]melodica_token=([^&]+)/.exec(location.hash || '');
  if (!m) return;
  const api = globalThis.browser || globalThis.chrome;
  try {
    const p = api.runtime.sendMessage({ type: 'github-token', token: decodeURIComponent(m[1]) });
    if (p && p.catch) p.catch(() => {});
  } catch (e) { /* the background answers nothing when no sign-in is pending */ }
})();
