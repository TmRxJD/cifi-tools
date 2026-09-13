# Chrome Web Store listing — CIFI Tools Companion

Copy-paste source for every Developer Dashboard field, kept in the repo so each update reuses it.
Not part of the package (the zip excludes `*.md`).

## Package

Build, then zip `extension/` without the docs:

```bash
node tools/build-companion.js --check
```

## Store listing tab

- **Name** (from manifest): CIFI Tools Companion
- **Summary** (from manifest): Adds hunter and fleet build optimization, Effective Path planning,
  and save-file import to cifi-tools.com.
- **Description**:

```
CIFI Tools Companion adds planning tools to cifi-tools.com, right inside the site you already use. Unofficial — not affiliated with cifi-tools.com, Vash, or Octocube Games.

What it adds:
• Hunter build optimizer — finds strong talent and attribute allocations for Borge, Ozzy, and Knox at your level, using cifi-tools.com's own simulator.
• Effective Path — ranks your next stat, inscryption, and relic purchases by gain per cost, so you know what to buy next.
• Fleet optimizer — plans install allocations across your whole fleet, with gear, badges, crew, and rank accounted for.
• Save-file import — load your progress from a save file, or pull it straight from your phone or emulator with the optional CIFI Bridge app.

Everything runs in your browser. No account, no server, no tracking — your data never leaves your device.
```

- **Category**: Games (under Lifestyle). If the dashboard's list differs, use Tools.
- **Language**: English
- **Store icon**: `extension/icons/icon128.png`
- **Screenshots** (1280×800): captured from the live extension on cifi-tools.com
- **Small promo tile** (440×280): generated alongside the screenshots
- **Homepage URL**: https://github.com/TmRxJD/cifi-tools
- **Support URL**: https://github.com/TmRxJD/cifi-tools/issues

## Privacy tab

- **Single purpose**: Adds build-planning tools (hunter and fleet optimization, Effective Path,
  save import) to cifi-tools.com, a companion site for the game CIFI.
- **Host permission justification** (content scripts on `https://cifi-tools.com/*`): The extension
  only adds pages to cifi-tools.com. Its content scripts run on that one site to insert the added
  pages into its navigation, read the game progress the site already stores in the browser, and
  run evaluations through the site's own simulation worker. It runs on no other site.
- **Remote code**: No. All JavaScript ships in the package; evaluations are performed by
  cifi-tools.com's own worker on its own page. (Since 2.8.0 — earlier versions compiled the site's
  wasm inside the content script, which counts as remote code.)
- **Data usage**: collects nothing. Tick all three certifications: not sold to third parties; not
  used for purposes unrelated to the single purpose; not used for creditworthiness or lending.
- **Privacy policy URL**: https://tmrxjd.github.io/cifi-tools/privacy.html

## Distribution tab

- Visibility: Public · Pricing: Free · Regions: All

## Known review risks

- **Name.** It contains "CIFI Tools", the name of the site it extends. Store policy prohibits
  implying affiliation with another brand; the description's first line says it is unofficial. If
  a reviewer objects anyway, rename to something like "Companion for CIFI Tools" and resubmit.
- **`import()` in `hostRouting.js`.** It imports cifi-tools.com's own entry module (the URL of the
  `<script type="module">` the page already loaded) to reach the site's sidebar component and
  hunter data. The page has already evaluated that module, so the import returns the existing
  module and runs no new code. If flagged as remote code, that is the answer.
- **Installer link.** The save-import dialog links to the adb-bridge installer on GitHub releases,
  a separate app the user may choose to install. It is a plain link; the extension never downloads
  or runs anything.
