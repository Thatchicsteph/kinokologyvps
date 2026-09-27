// Virtual (software) test device — a drop-in stand-in for ButtplugClient that
// needs no Intiface Engine, no Bluetooth, and no hardware. It mimics both toy
// families the app drives:
//   • a "Virtual Lovense"  — a vibrator, receives ScalarCmd-style 0..1 intensity
//   • a "Virtual OSSM"     — a stroker, same intensity interface for testing
// so the entire toy UI (connect, sliders, all patterns, SPEED-link, the guest
// relay) can be exercised end to end without any physical device.
//
// It intentionally matches ButtplugClient's public surface exactly
// (connect/disconnect/list/startScanning/stopScanning/vibrate/stopDevice/
// stopAll + onDevicesChanged/onDisconnected) so useToys can swap it in with no
// other code changes. Beyond that surface it records the last intensity per
// device and exposes an onIntensity callback, so a UI panel or a test can SEE
// what the app is sending.

const VIRTUAL_DEVICES = [
  { index: 0, name: "Virtual Lovense", vibeCount: 1, kind: "vibrator" },
  { index: 1, name: "Virtual OSSM", vibeCount: 1, kind: "stroker" },
];

export class VirtualToyClient {
  constructor() {
    this.devices = new Map();
    this.onDevicesChanged = null;
    this.onDisconnected = null;
    // Extra observability, not part of the ButtplugClient contract:
    this.onIntensity = null;            // ({index, name, kind, intensity}) => void
    this.lastIntensity = new Map();     // index -> 0..1
    this._connected = false;
  }

  connect() {
    // Resolve on the next tick so callers that await connect() behave exactly
    // as they do with the real (async) client.
    return new Promise((resolve) => {
      setTimeout(() => {
        this._connected = true;
        VIRTUAL_DEVICES.forEach((d) => {
          this.devices.set(d.index, { ...d });
          this.lastIntensity.set(d.index, 0);
        });
        this.onDevicesChanged && this.onDevicesChanged(this.list());
        resolve();
      }, 50);
    });
  }

  disconnect() {
    const wasConnected = this._connected;
    this._connected = false;
    this.devices.clear();
    this.lastIntensity.clear();
    if (wasConnected && this.onDisconnected) this.onDisconnected();
  }

  list() {
    return Array.from(this.devices.values()).map(({ index, name, vibeCount, kind }) => ({
      index, name, vibeCount, kind,
    }));
  }

  // No-ops: nothing to scan for, but keep the interface identical.
  startScanning() { return Promise.resolve(); }
  stopScanning() { return Promise.resolve(); }

  // intensity: 0..1 — record it and echo through onIntensity so the UI/tests
  // can display exactly what a real toy would have received.
  vibrate(deviceIndex, intensity) {
    const clamped = Math.min(1, Math.max(0, Number(intensity) || 0));
    const device = this.devices.get(deviceIndex);
    if (!device) return Promise.resolve();
    this.lastIntensity.set(deviceIndex, clamped);
    if (this.onIntensity) {
      this.onIntensity({ index: deviceIndex, name: device.name, kind: device.kind, intensity: clamped });
    }
    return Promise.resolve();
  }

  stopDevice(deviceIndex) {
    return this.vibrate(deviceIndex, 0);
  }

  stopAll() {
    this.devices.forEach((_, index) => {
      this.lastIntensity.set(index, 0);
      if (this.onIntensity) {
        const d = this.devices.get(index);
        this.onIntensity({ index, name: d.name, kind: d.kind, intensity: 0 });
      }
    });
    return Promise.resolve();
  }
}
