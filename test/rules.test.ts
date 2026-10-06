import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_RULES, emptyWindow, evaluate, push } from '../src/detect/rules.js'
import type { Device, Reading } from '../src/shared/types.js'

const device: Device = {
  deviceId: 'hvac-01',
  kind: 'hvac',
  buildingId: 'bldg-a',
  floor: 3,
  normalRange: { min: 20, max: 26 },
  unit: 'celsius',
}

const T0 = 1_700_000_000_000
const reading = (value: number, offsetMs = 0): Reading => ({
  deviceId: device.deviceId,
  buildingId: device.buildingId,
  kind: device.kind,
  value,
  unit: 'celsius',
  timestamp: T0 + offsetMs,
})

/** Feed a sequence of values into a fresh window. */
function windowOf(values: number[]) {
  let w = emptyWindow(T0)
  values.forEach((v, i) => {
    w = push(w, reading(v, i * 1000), DEFAULT_RULES)
  })
  return w
}

test('a single out-of-band reading does not fire — sensors bounce', () => {
  const w = windowOf([23, 23, 31])
  const { anomalies } = evaluate(device, w, T0 + 3000)
  assert.equal(anomalies.filter((a) => a.type === 'threshold_breach').length, 0)
})

test('three consecutive out-of-band readings fire a breach', () => {
  const w = windowOf([23, 31, 32, 33])
  const { anomalies } = evaluate(device, w, T0 + 4000)
  const breach = anomalies.find((a) => a.type === 'threshold_breach')
  assert.ok(breach, 'expected a threshold_breach')
  assert.equal(breach.evidence.length, DEFAULT_RULES.breachStreak)
})

test('a breach fires once, not on every subsequent reading', () => {
  let w = windowOf([31, 32, 33])
  const first = evaluate(device, w, T0 + 3000)
  assert.equal(first.anomalies.filter((a) => a.type === 'threshold_breach').length, 1)

  w = push(first.window, reading(34, 4000), DEFAULT_RULES)
  const second = evaluate(device, w, T0 + 4000)
  assert.equal(
    second.anomalies.filter((a) => a.type === 'threshold_breach').length,
    0,
    'already-firing condition must stay silent',
  )
})

test('a cleared breach can fire again later', () => {
  let w = windowOf([31, 32, 33])
  const fired = evaluate(device, w, T0 + 3000)

  // Back inside the band — condition clears.
  w = push(fired.window, reading(23, 4000), DEFAULT_RULES)
  const cleared = evaluate(device, w, T0 + 4000)
  assert.equal(cleared.window.firing.has('threshold_breach'), false)

  // Breaches again.
  w = push(cleared.window, reading(31, 5000), DEFAULT_RULES)
  w = push(w, reading(32, 6000), DEFAULT_RULES)
  w = push(w, reading(33, 7000), DEFAULT_RULES)
  const refired = evaluate(device, w, T0 + 7000)
  assert.equal(refired.anomalies.filter((a) => a.type === 'threshold_breach').length, 1)
})

test('silence fires with no readings at all — the failure naive pipelines miss', () => {
  const w = emptyWindow(T0)
  const { anomalies } = evaluate(device, w, T0 + DEFAULT_RULES.silenceMs + 1)
  const silent = anomalies.find((a) => a.type === 'device_silent')
  assert.ok(silent, 'expected device_silent')
  assert.equal(silent.severity, 'critical')
})

test('a device reporting on time is not silent', () => {
  const w = windowOf([23, 24, 23])
  const { anomalies } = evaluate(device, w, T0 + 3000)
  assert.equal(anomalies.filter((a) => a.type === 'device_silent').length, 0)
})

test('drift needs a full window — it is not a noisy threshold rule', () => {
  // Three readings well off-centre, but nowhere near windowSize.
  const w = windowOf([30, 30, 30])
  const { anomalies } = evaluate(device, w, T0 + 3000)
  assert.equal(anomalies.filter((a) => a.type === 'sensor_drift').length, 0)
})

test('a full window biased off centre fires drift', () => {
  // Band is 20–26, centre 23. A mean of 30 is ~30% off.
  const w = windowOf(Array(DEFAULT_RULES.windowSize).fill(30))
  const { anomalies } = evaluate(device, w, T0 + 20_000)
  const drift = anomalies.find((a) => a.type === 'sensor_drift')
  assert.ok(drift, 'expected sensor_drift')
})

test('a full window centred in band does not fire drift', () => {
  const w = windowOf(Array(DEFAULT_RULES.windowSize).fill(23))
  const { anomalies } = evaluate(device, w, T0 + 20_000)
  assert.equal(anomalies.filter((a) => a.type === 'sensor_drift').length, 0)
})

test('window is bounded by windowSize — memory stays O(devices)', () => {
  const w = windowOf(Array(DEFAULT_RULES.windowSize * 3).fill(23))
  assert.equal(w.readings.length, DEFAULT_RULES.windowSize)
})
