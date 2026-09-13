# Privacy Policy — CIFI Tools Companion

Last updated: 2026-09-13

## Summary

CIFI Tools Companion is a browser extension that adds hunter and fleet build optimization,
Effective Path planning, and save-file import to cifi-tools.com, running entirely in your own
browser. It has no server, collects no analytics or telemetry, and never sends your data to us or
anyone else.

## What the extension does

- Runs only on `https://cifi-tools.com/*`. It does not run on, read from, or modify any other site.
- Adds pages (Hunters, Fleet, Ship Setup, Gear Sets, Research, Academy Badges) to cifi-tools.com's
  own navigation, rendered inside that page.
- Reads game-progression data cifi-tools.com already keeps in your browser, so the added pages can
  show your builds and fleet.
- Saves your settings and builds in your browser's storage for cifi-tools.com — the same local
  storage the site itself uses. When you import a save, it can also write your imported gem
  progress into cifi-tools.com's own Gem Planner storage, so the site's native pages reflect it.
- Runs build evaluations through cifi-tools.com's own simulation worker, on cifi-tools.com. All of
  the extension's own code ships inside the extension; it does not download or run code from
  anywhere else.

## Save import and the optional local bridge

- You can import a save by choosing a save file. It is read in your browser and never uploaded.
- If you choose to run the separate CIFI Bridge (adb-bridge) app on your own computer, the
  extension connects to it at `127.0.0.1` (your own machine, port 43791) to pull your save from
  your own device. That connection never leaves your computer. If you don't run the bridge, nothing
  connects.

## What it does NOT do

- No account system, no sign-in, no user identifiers of any kind.
- No analytics, telemetry, crash reporting, or usage tracking.
- No data is sent to any server operated by this project. There is no backend.
- No data is sold, shared, or transmitted to any third party.
- It does not read or modify any site other than cifi-tools.com.

## External resources

The extension loads static game-art images (ship and gear icons) from a public GitHub Pages host
(`tmrxjd.github.io`), the same way a web page loads its own images. These requests carry no
tracking parameters or cookies — only what any standard image request sends — and no data about
you or your account.

## Data retention and deletion

Everything the extension saves stays in your browser's storage for cifi-tools.com, on your own
device. Uninstalling the extension stops it from running but does not erase what it saved there;
to remove that data, clear cifi-tools.com's site data in your browser's settings. Note that this
also clears cifi-tools.com's own saved data for that site.

## Changes to this policy

If this policy changes, the updated version will be published at the same address with a new
"Last updated" date.

## Contact

Questions or concerns: open an issue at https://github.com/TmRxJD/cifi-tools.
