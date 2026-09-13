# Privacy Policy — CIFI Tools Companion

Last updated: 2026-09-13

## Summary

CIFI Tools Companion is a browser extension that adds hunter and fleet build optimization,
Effective Path planning, and save-file import to cifi-tools.com, running entirely in your own
browser. It does not have a server, does not collect analytics or telemetry, and does not transmit
your account data anywhere.

## What the extension does

- Runs a content script on `https://cifi-tools.com/*` only. It does not run on, read from, or
  modify any other site.
- Adds pages (Hunters, Fleet, Ship Setup, Gear Sets, Research, Academy Badges) to cifi-tools.com's
  own navigation, rendered inside that page.
- Reads game-progression data already present in your browser (cifi-tools.com's own local storage
  and application state) so the added pages can show your current build/fleet — the same data the
  site itself already uses to render its pages.
- Uses `chrome.storage.local` to save your own settings and build configurations for the added
  pages (e.g. saved optimizer builds, filter/category preferences). Every key it writes is
  namespaced `cifi-companion:` so it cannot be confused with or overwrite cifi-tools.com's own
  storage.

## What it does NOT do

- No account system, no sign-in, no user identifiers of any kind.
- No analytics, telemetry, crash reporting, or usage tracking.
- No data is sent to any server operated by this project. There is no backend.
- No data collected by the extension is sold, shared, or transmitted to any third party.
- The extension does not read or modify any site other than cifi-tools.com.

## External resources

The extension fetches static game-art images (ship/gear icons) from a public GitHub Pages host
(`tmrxjd.github.io`) at runtime, the same way a web page loads its own images. These are static
image files with no tracking parameters, cookies, or identifying information attached to the
request beyond what any standard HTTP image request sends (the requesting browser's normal
headers). No data about you or your account is included in these requests.

## Data retention and deletion

All data the extension stores (`chrome.storage.local`, namespaced `cifi-companion:`) stays on your
own device. Uninstalling the extension removes it. Clearing the extension's storage from Chrome's
extension management page also removes it without affecting cifi-tools.com's own site data.

## Changes to this policy

If this policy changes, the updated version will be committed to this repository with a new
"Last updated" date.

## Contact

Questions or concerns: open an issue at the project's GitHub repository.
