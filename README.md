# Price Tags

A web app for printing price tag labels on a Katasymbol / Supvan **T50M Pro**.
Keep one copy of every label; pick a location and the booth number at the top
swaps automatically.

## Run it on this Mac

```
node tools/serve.mjs
```

Then open **http://localhost:8080** in **Google Chrome** (not Safari — Safari has
no Bluetooth support). Turn the printer on, go to *Setup* → *Connect printer*.

## Run it on the iPhone

The app has to be served over HTTPS and opened in the free
[Bluefy](https://apps.apple.com/us/app/bluefy-web-ble-browser/id1492822055)
browser. Safari cannot talk to Bluetooth devices at all.

## Check how the printer is reachable

```
tools/ble-probe.app/Contents/MacOS/ble-probe
```

Scans for the printer and prints its Bluetooth services. Launch it with
`open -W tools/ble-probe.app` the first time so macOS shows the Bluetooth
permission prompt.
