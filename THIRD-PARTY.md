# Third-party content in this repo — OPEN ITEM, pending permission

**Status: item 1 (the wasm) has a resolution IN PROGRESS — see route 4 below, still awaiting a
reply from the cifi-tools author (Vash). Item 2 (game artwork) is a SEPARATE question with a
different rights-holder, and the project owner has decided to keep shipping it — see item 2.**

**What changed:** `extension/` is now a companion that runs INSIDE cifi-tools.com rather than a
bridge into our own site. On their origin their engine is same-origin, so it is fetched from the
server that owns it and nothing is copied. That resolves the wasm question **for the extension**.
It does NOT resolve it for the website: `webapp/public/release.wasm` is still committed and still
served from GitHub Pages, because the website still exists and cannot run without it. The wasm item
below closes completely only if the website is retired in favour of the extension — which is now a
real option rather than a hypothetical, and is the decision this file is waiting on.

This repo currently commits, and GitHub Pages currently serves, content that this project did not
author. That is redistribution regardless of intent, and it is deliberately recorded here rather
than quietly left in place. Everything below is still tracked and the site still works — the
decision is on hold, not made.

Nothing in this file is legal advice. It is an inventory so the decision can be made on facts.

---

## 1. `webapp/public/release.wasm` — cifi-tools.com's compiled evaluator

The load-bearing one. This is **their build output**, not ours.

| | |
|---|---|
| Tracked since | the initial commit (`1d7301c`) |
| Size / sha1 | 93,667 bytes / `98faed542c19ddb7bbf031ce48bc75ae67da70a8` |
| Their current copy | `https://cifi-tools.com/wasm/release.wasm` — 94,410 bytes, different hash |
| Served publicly from | `https://tmrxjd.github.io/cifi-tools/release.wasm` (HTTP 200) |
| Loaded by | `hunterSimBrowser.js` → `assetUrl('release.wasm')` (one call site) |

Ours is an **older build of their file** — they have since updated theirs. We read its parameter
interface and call it; we did not produce it and do not own it.

**Removing it breaks the tool completely.** The simulator is the wasm; without it the site is a UI
with no math. Every bench in `tools/bench/` also runs against it.

### Hosting it elsewhere does NOT resolve this

Considered and rejected, recorded so it is not revisited as though it were new:

- **Serving it from Appwrite** (storage or a Function) cleans the repo but does not stop the
  redistribution — a visitor still receives their binary from infrastructure we control, and
  choosing to host it is a more deliberate act than having inherited it in an early commit.
- **Hotlinking it at runtime** is not available anyway: `cifi-tools.com/wasm/release.wasm` returns
  **no `Access-Control-Allow-Origin` header**, so a browser on our origin is blocked by CORS.
  Measured, not assumed.
- **Proxying it through an Appwrite Function** (fetch on demand, add the CORS header) is
  redistribution with an extra hop, and puts our traffic on their bandwidth without asking.

### The routes that do resolve it

1. **Permission.** Asked; awaiting reply. The hope is to contribute upstream as a PR instead —
   this project has fleet and ship-install optimization cifi-tools does not, so upstreaming is
   plausibly better for everyone than two sites.
2. **Local-only.** Repo and site stop carrying it; each user fetches it once for their own machine
   (`curl -o webapp/public/release.wasm https://cifi-tools.com/wasm/release.wasm`). Honest, needs
   no permission, costs the frictionless public tool.
3. **Our own evaluator.** The genuinely clean answer and the long game. We already hold the APK, the
   recovered C#, the authored coefficients and `params.json`'s full interface. Be clear-eyed about
   scale: 101/89/91 parameters across three hunters, a whole combat/loot simulation, and it must be
   comparable to the original or every bench loses its reference.
4. **Run inside cifi-tools.com as a browser extension.** IMPLEMENTED — `extension/`. Their page
   loads their engine from their server; our content script adds fleet/ship pages beside it. No
   copy is made, hosted, or transmitted, and the user is already signed in to their own cifi-tools
   account, so no account data leaves their control either.

   **Why this is different from routes 1–3 rather than a variant of them.** Route 2 (local-only)
   still asks every user to fetch the binary themselves; this asks nobody for anything, because the
   fetch is one their browser already makes when they open the site. Hosting is not involved at
   all, so the objection that sank Appwrite does not apply.

   **What it does NOT do, stated plainly:** it does not remove `webapp/public/release.wasm` from
   this repo. Anyone using the website still receives their binary from us. The redistribution ends
   only when the website does.

   **The remaining question is social, not technical.** This modifies their UI in the user's own
   browser — the ad-blocker model, and far safer ground than hosting their build output. But it is
   still their interface, and the courtesy of asking is worth more than the argument that we may.
   Nothing here changes the plan to talk to Vash first.

---

## 2. Game artwork extracted from the CIFI APK — 168 files, ~17 MB

The game developers' copyrighted assets, extracted from the APK and committed.

**THIS IS NOT VASH'S TO GRANT, and an earlier version of this file wrongly bundled it into the
"awaiting Vash" question.** cifi-tools uses the very same game assets; it owns none of them. So a
reply from Vash settles the wasm (item 1) and nothing here. The rights-holder is the game's
developer. On 2026-09-12 the project owner decided to keep shipping the game art as cifi-tools
does, which is why new icons have been added since — recorded here so the decision is visible
rather than implied.

| path | files | size | added |
|---|---|---|---|
| `webapp/public/assets/nodes/` | 77 | 2.0 MB | `44ac3fb` (2026-09-08) |
| `webapp/public/assets/ships/` | 48 | 13 MB | `76d5a97` (2026-09-08) |
| `webapp/public/assets/gear/` | 37 | 1.7 MB | `99b76b5` (2026-09-08) |
| `webapp/public/assets/materials/` | 9 | — | 2026-09-12 (replaces Borge-only `loot_mat*.png`) |
| `webapp/public/assets/hunter_*.png` | 3 | — | earlier |

**This is PURELY COSMETIC and can be removed at any time with no functional loss.** Every consumer
already falls back: gear `<img>` removes itself on error, ship portraits fall back to the static
portrait and then to nothing, node icons fall back to a plain tile. A clone without them is a
working tool with a plainer UI.

All of it regenerates from an APK you supply yourself:

```
CIFI_APK=apk-0.7.3.61 python tools/assets/extract-node-sprites.py --write
CIFI_APK=apk-0.7.3.61 python tools/assets/extract-ship-evo-sprites.py --write
CIFI_APK=apk-0.7.3.61 python tools/assets/extract-gear-icons.py --write
CIFI_APK=apk-0.7.3.61 python tools/assets/extract-material-icons.py --write
```

Note the dates: 161 of these were committed on **2026-09-08**, in this project's own sweep to
replace hand-cropped wiki screenshots with real sprites. `.gitignore` already says extracted game
files are *"not ours to redistribute"* — that rule was not applied to these, and should have been.

---

## 3. What is NOT in question

`params.json` and everything under `tools/reference/` stay. They hold recovered **facts** —
parameter names, authored coefficients, caps, gates, node mappings — produced by this project's own
extraction work, and they are what make its claims checkable. Copying a UI layout is likewise not
the concern here.

The line this file draws: **publish what we derived, not what we copied.**

---

## When the answer comes back

- **Yes / upstream PR** → nothing to remove; delete this file's "unresolved" framing and record the
  permission and its scope here instead.
- **No** → remove both categories. The art costs nothing; the wasm turns the hosted site into a
  run-it-yourself tool. `git rm --cached` plus `.gitignore` entries covers future distribution, but
  **history keeps them** — both stay fetchable at their original commits unless the history is
  rewritten, which is a separate, destructive decision about a public repo.
