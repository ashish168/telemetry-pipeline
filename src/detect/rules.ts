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
  /** Fractional deviation of window mean from band centre that counts as drift. */
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
  driftTolerance: 0.15,
  silenceMs: 60_000,
}

/** Rolling per-device state. Bounded by windowSize, so memory is O(devices). */
export interface DeviceWindow {
  readings: Reading[]
  lastSeen: number
  /** Suppresses repeat alerts for a condition already reported. */
  firing: Set<Anomaly['type']>
}

export function emptyWindow(now: number): DeviceWindow {
  return { readings: [], lastSeen: now, firing: new Set() }
}

export function push(window: DeviceWindow, reading: Reading, cfg: RuleConfig): DeviceWindow {
  const readings = [...window.readings, reading].slice(-cfg.windowSize)
  return { ...window, readings, lastSeen: reading.timestamp }
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
  // Deliberately requires a full window. Drift is a slow failure; calling it on
  // three readings would just be a noisier threshold rule.
  let drifted = false
  if (window.readings.length === cfg.windowSize) {
    const centre = (min + max) / 2
    const observed = mean(window.readings.map((r) => r.value))
    const deviation = Math.abs(observed - centre) / (centre || 1)
    drifted = deviation > cfg.driftTolerance

    if (drifted && !firing.has('sensor_drift')) {
      firing.add('sensor_drift')
      anomalies.push({
        ...base,
        type: 'sensor_drift',
        severity: 'warning',
        detail: `Window mean ${observed.toFixed(1)} is ${(deviation * 100).toFixed(0)}% from band centre ${centre.toFixed(1)}`,
        evidence: window.readings.slice(-5),
      })
    }
  }
  if (!drifted) firing.delete('sensor_drift')

  return { anomalies, window: { ...window, firing } }
}
