// ── Detection rules ──
//
// Pure functions over a per-device window of readings. No I/O, no clock, no
// broker — the caller supplies `now`. That is what makes this file the one
// worth testing, and it is where the domain judgement actually lives.
//
// Three detectors, because these are the three ways building sensors fail in
// practice:
//
//   threshold_breach  the value is wrong        — a unit running hot
//   sensor_drift      the value is drifting     — a meter losing calibration
//   device_silent     there is no value at all  — the failure people miss
//
// The third matters most and is the one naive pipelines skip: a dead sensor
// emits nothing, so a system that only inspects incoming readings never fires.

import type { Anomaly, Device, Reading } from '../shared/types.js'

export interface RuleConfig {
  /** Consecutive out-of-band readings before a breach is called. */
  breachStreak: number
  /** Readings held per device for drift analysis. */
  windowSize: number
  /** Readings used to establish a device's own baseline before drift is judged. */
  baselineSize: number
  /** Fractional deviation of the window mean from that baseline that counts as drift. */
  driftTolerance: number
  /** Silence beyond this many ms means the device is presumed dead. */
  silenceMs: number
}

export const DEFAULT_RULES: RuleConfig = {
  // One reading outside the band is noise — sensors bounce. Three in a row is a
  // signal. This single number is the difference between a useful alert stream
  // and one operators learn to ignore.
  breachStreak: 3,
  windowSize: 20,
  baselineSize: 40,
  driftTolerance: 0.15,
  silenceMs: 60_000,
}

/** Rolling per-device state. Bounded by windowSize, so memory is O(devices). */
export interface DeviceWindow {
  readings: Reading[]
  lastSeen: number
  /** Suppresses repeat alerts for a condition already reported. */
  firing: Set<Anomaly['type']>
  /**
   * The device's own established mean, learned from its first `baselineSize`
   * readings. Undefined until enough history exists — drift is not judged
   * before then.
   */
  baseline?: number
  /** Running total used to compute the baseline, discarded once it is set. */
  seen: number
  sum: number
}

export function emptyWindow(now: number): DeviceWindow {
  return { readings: [], lastSeen: now, firing: new Set(), seen: 0, sum: 0 }
}

export function push(window: DeviceWindow, reading: Reading, cfg: RuleConfig): DeviceWindow {
  const readings = [...window.readings, reading].slice(-cfg.windowSize)
  const seen = window.seen + 1
  const sum = window.sum + reading.value
  // Learn the baseline once, from the device's own early behaviour.
  const baseline =
    window.baseline ?? (seen >= cfg.baselineSize ? sum / seen : undefined)
  return { ...window, readings, lastSeen: reading.timestamp, seen, sum, baseline }
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length

/**
 * Evaluate a device against all three rules.
 *
 * Returns anomalies that are newly firing. A condition already firing stays
 * silent until it clears and recurs — without this, one stuck sensor produces
 * an alert per reading and the operator stops reading alerts.
 */
export function evaluate(
  device: Device,
  window: DeviceWindow,
  now: number,
  cfg: RuleConfig = DEFAULT_RULES,
): { anomalies: Anomaly[]; window: DeviceWindow } {
  const anomalies: Anomaly[] = []
  const firing = new Set(window.firing)
  const { min, max } = device.normalRange
  const base = { deviceId: device.deviceId, buildingId: device.buildingId, detectedAt: now }

  // ── Silence ──
  // Checked first and independently of readings: this is the only rule that can
  // fire when nothing has arrived, which is precisely why it exists.
  const silent = now - window.lastSeen > cfg.silenceMs
  if (silent && !firing.has('device_silent')) {
    firing.add('device_silent')
    anomalies.push({
      ...base,
      type: 'device_silent',
      severity: 'critical',
      detail: `No reading for ${Math.round((now - window.lastSeen) / 1000)}s (threshold ${cfg.silenceMs / 1000}s)`,
      evidence: window.readings.slice(-1),
    })
  }
  if (!silent) firing.delete('device_silent')

  // ── Threshold breach ──
  const tail = window.readings.slice(-cfg.breachStreak)
  const streakBreached =
    tail.length === cfg.breachStreak && tail.every((r) => r.value < min || r.value > max)

  if (streakBreached && !firing.has('threshold_breach')) {
    firing.add('threshold_breach')
    const last = tail[tail.length - 1]!
    anomalies.push({
      ...base,
      type: 'threshold_breach',
      severity: last.value > max * 1.25 || last.value < min * 0.75 ? 'critical' : 'warning',
      detail: `${cfg.breachStreak} consecutive readings outside ${min}–${max} ${device.unit} (latest ${last.value.toFixed(1)})`,
      evidence: tail,
    })
  }
  if (!streakBreached) firing.delete('threshold_breach')

  // ── Drift ──
  //
  // Measured against the device's OWN baseline, not the centre of its allowed
  // band. That distinction matters: an electricity meter legitimately swings
  // from near-idle overnight to peak mid-afternoon, so its honest mean sits
  // nowhere near mid-band. Judging it against band centre flags healthy
  // hardware every single day — which is precisely the alert fatigue the
  // breach-streak rule exists to avoid.
  //
  // Requires both a full window and an established baseline. Drift is a slow
  // failure; calling it early would just be a noisier threshold rule.
  let drifted = false
  if (window.readings.length === cfg.windowSize && window.baseline !== undefined) {
    const observed = mean(window.readings.map((r) => r.value))
    const deviation = Math.abs(observed - window.baseline) / (Math.abs(window.baseline) || 1)
    drifted = deviation > cfg.driftTolerance

    if (drifted && !firing.has('sensor_drift')) {
      firing.add('sensor_drift')
      anomalies.push({
        ...base,
        type: 'sensor_drift',
        severity: 'warning',
        detail: `Window mean ${observed.toFixed(1)} is ${(deviation * 100).toFixed(0)}% from this device's baseline ${window.baseline.toFixed(1)}`,
        evidence: window.readings.slice(-5),
      })
    }
  }
  if (!drifted) firing.delete('sensor_drift')

  return { anomalies, window: { ...window, firing } }
}
