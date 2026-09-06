// ble-probe.swift — one-shot BLE discovery probe for the Supvan/Katasymbol T50M Pro.
//
// Answers one question: does this printer expose a BLE GATT service that the
// Web Bluetooth API (i.e. the Bluefy browser on iOS) can talk to?
//
// Build: swiftc -O tools/ble-probe.swift -o tools/ble-probe
// Run:   tools/ble-probe            (scans everything)
//        tools/ble-probe T50        (only connect to names containing "T50")

import Foundation
import CoreBluetooth

// Service UUIDs the vendor's own BLEUtils.java looks for, per the supvan-cups
// protocol notes. A hit on any of these means the direct-from-phone path works.
let knownServicePrefixes = ["0000FEE7", "0000E0FF", "0000FF00"]

let nameFilter = CommandLine.arguments.count > 1 ? CommandLine.arguments[1].uppercased() : nil
let scanSeconds = 15.0

func looksLikePrinter(_ name: String?) -> Bool {
    guard let n = name?.uppercased() else { return false }
    if let f = nameFilter { return n.contains(f) }
    for hint in ["T50", "SUPVAN", "KATA", "T80", "G15", "PRINT"] where n.contains(hint) { return true }
    // vendor advertises names like T50, G15, D11 — letter + two digits
    return n.range(of: "^[TGD][0-9]{2}", options: .regularExpression) != nil
}

final class Probe: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {
    var central: CBCentralManager!
    var seen: [UUID: String] = [:]
    var connecting: Set<UUID> = []
    var keepAlive: [CBPeripheral] = []
    var pendingServices = 0

    func start() { central = CBCentralManager(delegate: self, queue: nil) }

    func centralManagerDidUpdateState(_ c: CBCentralManager) {
        switch c.state {
        case .poweredOn:
            print("Bluetooth ready. Scanning \(Int(scanSeconds))s — make sure the printer is ON.\n")
            c.scanForPeripherals(withServices: nil, options: [CBCentralManagerScanOptionAllowDuplicatesKey: false])
            DispatchQueue.main.asyncAfter(deadline: .now() + scanSeconds) { self.finishScan() }
        case .unauthorized:
            print("DENIED: this process has no Bluetooth permission.")
            print("Fix: System Settings > Privacy & Security > Bluetooth, enable the terminal app, then rerun.")
            exit(2)
        case .poweredOff:
            print("Bluetooth is OFF on this Mac. Turn it on and rerun."); exit(3)
        default:
            break
        }
    }

    func centralManager(_ c: CBCentralManager, didDiscover p: CBPeripheral,
                        advertisementData ad: [String: Any], rssi: NSNumber) {
        let name = p.name ?? (ad[CBAdvertisementDataLocalNameKey] as? String)
        let key = p.identifier
        if seen[key] == nil {
            seen[key] = name ?? "(no name)"
            let services = (ad[CBAdvertisementDataServiceUUIDsKey] as? [CBUUID])?.map { $0.uuidString } ?? []
            let mark = looksLikePrinter(name) ? " <== CANDIDATE" : ""
            print("• \(name ?? "(unnamed)")  rssi \(rssi)  services: \(services.isEmpty ? "none advertised" : services.joined(separator: ", "))\(mark)")
        }
        if looksLikePrinter(name), !connecting.contains(key) {
            connecting.insert(key)
            keepAlive.append(p)
            p.delegate = self
            pendingServices += 1
            print("  -> connecting to \(name ?? "?") to enumerate GATT services...")
            c.connect(p, options: nil)
        }
    }

    func centralManager(_ c: CBCentralManager, didConnect p: CBPeripheral) {
        print("  connected: \(p.name ?? "?"). Discovering services...")
        p.discoverServices(nil)
    }

    func centralManager(_ c: CBCentralManager, didFailToConnect p: CBPeripheral, error: Error?) {
        print("  connect FAILED for \(p.name ?? "?"): \(error?.localizedDescription ?? "unknown")")
        pendingServices -= 1
    }

    func peripheral(_ p: CBPeripheral, didDiscoverServices error: Error?) {
        guard let services = p.services, !services.isEmpty else {
            print("  \(p.name ?? "?"): NO GATT SERVICES (this device is Bluetooth Classic only).")
            pendingServices -= 1
            return
        }
        print("\n  GATT services on \(p.name ?? "?"):")
        for s in services {
            let hit = knownServicePrefixes.contains { s.uuid.uuidString.uppercased().hasPrefix($0) }
            print("    service \(s.uuid.uuidString)\(hit ? "   *** KNOWN SUPVAN SERVICE ***" : "")")
            p.discoverCharacteristics(nil, for: s)
        }
    }

    func peripheral(_ p: CBPeripheral, didDiscoverCharacteristicsFor s: CBService, error: Error?) {
        for ch in s.characteristics ?? [] {
            var props: [String] = []
            if ch.properties.contains(.read) { props.append("read") }
            if ch.properties.contains(.write) { props.append("write") }
            if ch.properties.contains(.writeWithoutResponse) { props.append("writeNoResp") }
            if ch.properties.contains(.notify) { props.append("notify") }
            if ch.properties.contains(.indicate) { props.append("indicate") }
            print("      char \(ch.uuid.uuidString)  [\(props.joined(separator: ","))]")
        }
        pendingServices -= 1
        if pendingServices <= 0 {
            DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) { self.report() }
        }
    }

    func finishScan() {
        central.stopScan()
        if connecting.isEmpty {
            print("\nNo printer-looking device advertised over BLE.")
            print("Either the printer is off/asleep, or it only speaks Bluetooth Classic (no BLE).")
            exit(1)
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 8.0) { self.report() }
    }

    func report() {
        print("\nDone.")
        exit(0)
    }
}

freopen("/private/tmp/claude-501/-Users-bbass-Projects-label-printer-app/cc6ef2c5-9d10-47ac-8e95-8600f4911cf4/scratchpad/ble-probe.log", "w", stdout)
freopen("/private/tmp/claude-501/-Users-bbass-Projects-label-printer-app/cc6ef2c5-9d10-47ac-8e95-8600f4911cf4/scratchpad/ble-probe.log.err", "w", stderr)
setvbuf(stdout, nil, _IONBF, 0)
let probe = Probe()
probe.start()
RunLoop.main.run()
