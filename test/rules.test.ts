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

test('drift waits for a baseline to be established', () => {
  // A full window, but fewer readings than baselineSize — nothing to compare to.
  const w = windowOf(Array(DEFAULT_RULES.windowSize).fill(30))
  assert.equal(w.baseline, undefined)
  const { anomalies } = evaluate(device, w, T0 + 20_000)
  assert.equal(anomalies.filter((a) => a.type === 'sensor_drift').length, 0)
})

test('a device that moves away from its own baseline fires drift', () => {
  // Establish a baseline around 23, then shift to 30.
  const w = windowOf([
    ...Array(DEFAULT_RULES.baselineSize).fill(23),
    ...Array(DEFAULT_RULES.windowSize).fill(30),
  ])
  assert.ok(w.baseline !== undefined, 'baseline should be established')
  const { anomalies } = evaluate(device, w, T0 + 60_000)
  assert.ok(anomalies.find((a) => a.type === 'sensor_drift'), 'expected sensor_drift')
})

test('a device holding steady at its baseline does not fire drift', () => {
  const w = windowOf(Array(DEFAULT_RULES.baselineSize + DEFAULT_RULES.windowSize).fill(23))
  const { anomalies } = evaluate(device, w, T0 + 60_000)
  assert.equal(anomalies.filter((a) => a.type === 'sensor_drift').length, 0)
})

// Regression. The first version measured drift against the centre of the
// allowed band, which flagged every healthy device whose normal operation is
// not centred — an electricity meter idles overnight and peaks mid-afternoon,
// so its honest mean sits well below mid-band. The CI demo caught this firing
// on a device with no seeded fault at all.
test('a healthy device operating off-centre but stable does not fire drift', () => {
  const meter: Device = {
    deviceId: 'meter-01',
    kind: 'electricity_meter',
    buildingId: 'bldg-a',
    floor: 0,
    normalRange: { min: 30, max: 90 }, // centre 60
    unit: 'kwh',
  }
  // Consistently around 43 — well inside the band, nowhere near its centre.
  const values = Array(DEFAULT_RULES.baselineSize + DEFAULT_RULES.windowSize)
    .fill(0)
    .map((_, i) => 43 + (i % 3))

  let w = emptyWindow(T0)
  values.forEach((v, i) => {
    w = push(w, { ...reading(v, i * 1000), deviceId: 'meter-01', kind: 'electricity_meter', unit: 'kwh' }, DEFAULT_RULES)
  })

  const { anomalies } = evaluate(meter, w, T0 + values.length * 1000)
  assert.equal(
    anomalies.length,
    0,
    `a stable healthy device must stay silent, got: ${anomalies.map((a) => a.type).join(', ')}`,
  )
})

// Regression. Widening the window was not enough on its own: a drift window
// shorter than one daily cycle measures the time of day, not the sensor. A
// window landing in the afternoon has a high mean, one landing overnight a low
// one, and the gap between them looks exactly like drift. The CI demo caught
// this firing on two healthy meters.
test('a healthy device on a daily cycle does not fire drift', () => {
  const meter: Device = {
    deviceId: 'meter-cyclic',
    kind: 'electricity_meter',
    buildingId: 'bldg-a',
    floor: 0,
    normalRange: { min: 30, max: 90 },
    unit: 'kwh',
  }

  // 24-hour cycle: idle overnight, peaking mid-afternoon. Stable day to day.
  const atHour = (h: number) => 43 + Math.max(0, Math.sin(((h - 6) / 14) * Math.PI)) * 27

  let w = emptyWindow(T0)
  const total = DEFAULT_RULES.baselineSize + DEFAULT_RULES.windowSize
  for (let i = 0; i < total; i++) {
    w = push(
      w,
      { ...reading(atHour(i % 24), i * 1000), deviceId: 'meter-cyclic', kind: 'electricity_meter', unit: 'kwh' },
      DEFAULT_RULES,
    )
  }

  const { anomalies } = evaluate(meter, w, T0 + total * 1000)
  assert.equal(
    anomalies.length,
    0,
    `a healthy cyclical device must stay silent, got: ${anomalies.map((a) => a.type).join(', ')}`,
  )
})

test('window is bounded by windowSize — memory stays O(devices)', () => {
  const w = windowOf(Array(DEFAULT_RULES.windowSize * 3).fill(23))
  assert.equal(w.readings.length, DEFAULT_RULES.windowSize)
})
