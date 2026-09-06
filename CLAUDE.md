<!-- PROJECT-HUB:SUMMARY -->
## Summary
_The project's one-paragraph description. Agents: keep this current — Project Hub reads it._

A phone-first web app for printing price tag labels on a Katasymbol/Supvan T50M Pro thermal printer. It stores a reusable library of item labels (name + price) and a list of booth locations, then swaps the booth number at the top of each label at print time — so the same label is kept once and printed for either booth. Talks to the printer directly over Bluetooth LE from the browser, with no native app to re-sign.
<!-- /PROJECT-HUB:SUMMARY -->

## Why this is a web app, not a native iOS app

The owner does not want to re-sign a sideloaded app every 7 days or pay for a
developer account. So this ships as a static web app.

The catch: **iOS Safari has no Web Bluetooth and never will** (Apple blocks it).
The workaround is [Bluefy](https://apps.apple.com/us/app/bluefy-web-ble-browser/id1492822055),
a free App Store browser that implements the Web Bluetooth API. The app is
opened inside Bluefy on the iPhone, over HTTPS, and talks BLE straight to the
printer. Nothing to sign, nothing to renew.

For development, Chrome on macOS supports Web Bluetooth natively — test there
first, then confirm on the phone.

## The printer

Katasymbol / Supvan **T50M Pro**. 203 dpi, 8 dots/mm, 48 mm (384 dot) printhead.
Labels in use: **40 x 30 mm**.

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
- Label rendering at 320 x 240 dots, booth banner + item + price, auto-fitting text.
- Full raster pipeline — column-major packing, 4096-byte print buffers with the
  firmware's odd 256-stride checksum, LZMA1 at 8 KB dictionary, 512-byte
  transfer frames. Byte-for-byte agreement with the reference driver's headers
  was checked in the browser, not just assumed.
- Label library, locations, queue with quantities, export/import.

Live at **https://bbass07.github.io/price-tags/** (repo `bbass07/price-tags`,
deployed from `web/` by `.github/workflows/pages.yml` on every push to `main`).

**End-to-end print confirmed on real hardware (2026-09-06)** from Bluefy on an
iPhone: connect, render, compress, transfer, print. The 8-dot feed margin
inherited from the reference driver is correct in practice.

## Getting it onto the Home Screen

Bluefy has no "Add to Home Screen", and Safari's version is a trap — it makes a
convincing standalone app that runs on WebKit and therefore can never reach the
printer. Third-party engines that could install a real web app are EU-only.

The working route is an iOS Shortcut using Bluefy's deep link, confirmed on the
owner's phone (2026-09-06):

```
bluefy://open?url=https%3A%2F%2Fbbass07.github.io%2Fprice-tags%2F
```

`bluefy://<host>/<path>` and the x-callback form both open the app but discard
the address; only the `open?url=` form navigates. `web/home-screen.html` holds
the instructions, a copy button, and a retest harness in case Bluefy changes it.

### Settled, do not relitigate

- **Fullscreen on iPhone is impossible from the page.** WebKit on iPhone has no
  element fullscreen, and every iOS browser is built on WebKit, so Bluefy
  exposes `requestFullscreen` and ignores it. The app detects that, records
  `settings.fullscreenBroken`, and stops offering the control. Bluefy's own
  fullscreen button works but it forgets the setting between launches — a
  Bluefy bug, not reachable from here.
- **Renaming the printer over Bluetooth** is not worth attempting. The write
  opcodes exist (`WR_DEV_OPT` 0x68, `WR_DEV_PAR` 0x6A) but their payloads are
  undocumented and they sit beside the firmware-update range; the reference
  driver refuses to send them on purpose. The app uses a local nickname instead
  (`settings.printerNickname`).

### Open work

- Bulk entry / editing of a large library — adding labels one at a time is fine
  for a handful, tedious for hundreds. This is the owner's most likely next ask.
- No barcode support; labels are text only.
- Untried: **BLE Link**, a second free Web BLE browser on the App Store. If its
  fullscreen persists across launches it replaces Bluefy outright, and the Home
  Screen shortcut would need its URL scheme instead.

### Working on this project

The owner is not a programmer. Explain in plain terms and skip the jargon.
Verify against real behaviour rather than reasoning about it — every bug found
here so far (mirrored print, the trapped editor, the silent Bluetooth failure)
was invisible until something real was run. `tools/serve.mjs` plus Chrome on the
Mac is the fast loop; the phone is the truth.
