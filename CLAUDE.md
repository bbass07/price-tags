<!-- PROJECT-HUB:SUMMARY -->
## Summary
_The project's one-paragraph description. Agents: keep this current — Project Hub reads it._

A phone-first web app for printing price tag labels on a Katasymbol/Supvan T50M Pro thermal printer, on fixed 30 x 15 mm stock. It keeps a library of item labels (name + price) and a list of booth locations, and swaps the booth number at the top of each label at print time, so one saved label prints for either booth. It reaches the printer over Bluetooth LE straight from the browser.
<!-- /PROJECT-HUB:SUMMARY -->

## Why this is a web app, not a native iOS app

The owner does not want to re-sign a sideloaded app every 7 days or pay for a
developer account. So this ships as a static web app.

The catch: **iOS Safari has no Web Bluetooth and never will** (Apple blocks it).
The workaround is a third-party browser that implements the Web Bluetooth API.
The app is opened inside one of those on the iPhone, over HTTPS, and talks BLE
straight to the printer. Nothing to sign, nothing to renew.

**[BLE Link](https://apps.apple.com/us/app/ble-link-web-ble-browser/id6468414672)
is the one in use** (free, iOS 16.4+). End-to-end print confirmed on it
(2026-09-11). [Bluefy](https://apps.apple.com/us/app/bluefy-web-ble-browser/id1492822055)
was used before it and still works — see the browser trade-off below.

For development, Chrome on macOS supports Web Bluetooth natively — test there
first, then confirm on the phone.

## The printer

Katasymbol / Supvan **T50M Pro**. 203 dpi, 8 dots/mm, 48 mm (384 dot) printhead.
Labels in use: **30 x 15 mm** (240 x 120 dots) — the only size, hard-coded in
`web/js/render.js` as `LABEL_WIDTH_MM` / `LABEL_HEIGHT_MM`. There is deliberately
no setting for it.

Verified on this hardware with `tools/ble-probe` (2026-09-06) — the unit
`T0205C2605108458` exposes a BLE GATT service that Web Bluetooth can reach:

| | |
|---|---|
| service | `0000e0ff-3c17-d293-8e48-14fe2e4da212` |
| notify char | `0000ffe1-0000-1000-8000-00805f9b34fb` |
| write char | `0000ffe9-0000-1000-8000-00805f9b34fb` |
| extra notify | `0000ffea-0000-1000-8000-00805f9b34fb` |

The printer advertises **no** service UUIDs, so device discovery must filter by
name prefix (`T0…`) or fall back to showing all devices.

### Protocol reference

`reference/supvan-cups/` is a shallow clone of
[heeen/supvan-cups](https://github.com/heeen/supvan-cups) — a reverse-engineered
Linux driver for this exact printer family. It is the source of truth; grep it
before guessing.

- `docs/PROTOCOL.md` — frame formats, opcodes, status bits, print sequence
- `crates/supvan-proto/src/cmd.rs` — opcodes and the 16-byte frame builder
- `crates/supvan-proto/src/bitmap.rs` — column-major 1bpp packing
- `crates/supvan-proto/src/compress.rs` — LZMA1-alone params (lc=3 lp=0 pb=2, dict 8192)
- `crates/supvan-app/src/job.rs` — `transfer_page`, the real print ordering

Key facts that bite:
- Every BLE frame is written in **128-byte fragments** with ~10 ms between them.
- Commands are acked by a notification echoing the command byte at **offset 7**.
- Bulk image data over BLE is **not** acked (unlike Classic Bluetooth).
- The raster is strictly **1 bit per pixel** — all shading is host-side dithering.
- The raster must be **mirrored horizontally** before column-major packing: the
  leftmost image dot goes to the highest printhead dot index. The reference
  driver hides this inside its dither stage (`dither.rs`, `mx = width - 1 - x`),
  so it is easy to drop when replacing dithering with a plain threshold. Getting
  it wrong prints readable-but-backwards labels.
- There is **no backfeed**: a fed label cannot be reprinted over.

## Layout

```
web/          the app itself — static files, no build step
tools/        ble-probe (macOS BLE discovery), dev server
reference/    cloned protocol documentation (not our code)
```

## Conventions

- No framework, no bundler, no build step. Plain ES modules. Load speed matters
  more than developer convenience here; the whole app should be a few hundred KB.
- The app must work offline once loaded (service worker), because booths have
  bad signal.
- The label library is the user's data. Never lose it: everything persists
  immediately, and export/import to a JSON file is a first-class feature.

## Status

Working and verified:
- BLE discovery, connect, status polling, printer identity.
- Label rendering at 240 x 120 dots: booth / item / price as three plain black
  lines of equal height, auto-fitting text. Every label has exactly those three
  lines — no inverted banner, no second line, no per-label layout. `store.js` strips the old `note` field from saved
  records and from imported backups on load, so nothing carries it forward.
- The editor *is* the label: `render.js` exports `labelLayout()`, and `ui.js`
  places the two inputs over a tag-shaped card using that same geometry scaled
  up. So the form is not a lookalike — a name that has to shrink to fit on
  paper shrinks on screen first. Change the layout in `labelLayout()` only.
- Full raster pipeline — column-major packing, 4096-byte print buffers with the
  firmware's odd 256-stride checksum, LZMA1 at 8 KB dictionary, 512-byte
  transfer frames. Byte-for-byte agreement with the reference driver's headers
  was checked in the browser, not just assumed.
- Label library, locations, queue with quantities, export/import.
- Printing is two screens: the Print tab is a menu of full-size booth buttons
  (`view-print`), and picking one opens the product list with quantity steppers
  for that booth (`view-pick`). Switching booths clears the queue on purpose —
  quantities carried across would print the wrong booth number.

Live at **https://bbass07.github.io/price-tags/** (repo `bbass07/price-tags`,
deployed from `web/` by `.github/workflows/pages.yml` on every push to `main`).

**End-to-end print confirmed on real hardware (2026-09-06)** from Bluefy on an
iPhone: connect, render, compress, transfer, print. The 8-dot feed margin
inherited from the reference driver is correct in practice.

## Getting it onto the Home Screen

Bluefy has no "Add to Home Screen", and Safari's version is a trap — it makes a
convincing standalone app that runs on WebKit and therefore can never reach the
printer. Third-party engines that could install a real web app are EU-only.

**With BLE Link there is nothing to set up.** It reopens on the last page, so
tapping its own icon lands in Price Tags — confirmed on the owner's phone
(2026-09-11). No Shortcut, no scheme, nothing to redo. Its URL scheme was never
found and is not needed; `home-screen.html` keeps a tester in case that changes.

The Bluefy route, confirmed on the owner's phone (2026-09-06), kept only as a
fallback:

```
bluefy://open?url=https%3A%2F%2Fbbass07.github.io%2Fprice-tags%2F
```

`bluefy://<host>/<path>` and the x-callback form both open the app but discard
the address; only the `open?url=` form navigates. `web/home-screen.html` holds
the instructions, a copy button, and a retest harness in case Bluefy changes it.

### Settled, do not relitigate

- **BLE Link over Bluefy** (decided 2026-09-11 after testing both on the
  owner's phone). BLE Link has no tabs and no fullscreen; Bluefy has both, but
  forgets fullscreen on every launch and keeps every past session as a tab that
  the `open?url=` shortcut adds to rather than reuses. So Bluefy's advantage was
  one the owner never actually got to keep, against a problem that grows
  without limit. Do not propose going back without a new reason.
- **Fullscreen on iPhone is impossible from the page, and the app no longer
  tries.** WebKit on iPhone has no element fullscreen, and every iOS browser is
  built on WebKit, so a shell can expose `requestFullscreen` and ignore it. The
  Setup screen's Display card, `web/js/fullscreen.js`, and the `autoFullscreen`
  / `fullscreenBroken` settings were all removed on 2026-09-11; `cleanSettings()`
  in `store.js` strips the two dead fields off saved data and imported backups.
  Do not add the control back — BLE Link has no fullscreen at all, so its
  address bar is simply always on screen.
- **Renaming the printer over Bluetooth** is not worth attempting. The write
  opcodes exist (`WR_DEV_OPT` 0x68, `WR_DEV_PAR` 0x6A) but their payloads are
  undocumented and they sit beside the firmware-update range; the reference
  driver refuses to send them on purpose. The app uses a local nickname instead
  (`settings.printerNickname`).

### Open work

- Bulk entry / editing of a large library — adding labels one at a time is fine
  for a handful, tedious for hundreds. This is the owner's most likely next ask.
- No barcode support; labels are text only.
- The app is served from GitHub Pages with `max-age=600`, so a phone can pair a
  new index.html with a ten-minute-old ui.js and simply stop responding. Guards:
  the service worker revalidates every fetch, index.html requests
  `js/ui.js?b=<build>`, and a page/script build mismatch reinstalls once. Bump
  the `BUILD` constant in `ui.js` **and** the `app-build` meta in `index.html`
  together on every deploy, plus `CACHE` in `sw.js`.

### Working on this project

The owner is not a programmer. Explain in plain terms and skip the jargon.
Verify against real behaviour rather than reasoning about it — every bug found
here so far (mirrored print, the trapped editor, the silent Bluetooth failure)
was invisible until something real was run. `tools/serve.mjs` plus Chrome on the
Mac is the fast loop; the phone is the truth.
