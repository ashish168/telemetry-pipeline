// ── Detection service ──
//
// Consumes readings, holds a bounded window per device, and applies the rules in
// rules.ts. All of the interesting logic is in that file and is unit-tested;
// this one is wiring.
//
// The periodic sweep matters as much as the stream handler: a silent device
// produces no messages, so a purely reactive consumer would never notice it.

import { consume, publish, producer, onShutdown } from '../shared/bus.js'
import { db } from '../shared/db.js'
import { TOPICS, type Anomaly, type Reading } from '../shared/types.js'
import { DEVICES } from '../simulator/devices.js'
import { config } from '../shared/config.js'
import { DEFAULT_RULES, emptyWindow, evaluate, push, type DeviceWindow } from './rules.js'

// Defaults, with the two timings that make a CI run take a minute instead of five.
const RULES = { ...DEFAULT_RULES, silenceMs: config.silenceMs }

const windows = new Map<string, DeviceWindow>()
const byId = new Map(DEVICES.map((d) => [d.deviceId, d]))

async function main() {
  const p = await producer()
  const anomalies = (await db()).collection<Anomaly>('anomalies')

  const emit = async (found: Anomaly[]) => {
    for (const a of found) {
      await anomalies.insertOne({ ...a })
      await publish(p, TOPICS.anomalies, a.deviceId, a)
      const mark = a.severity === 'critical' ? '!!' : ' !'
      console.log(`${mark} ${a.deviceId} ${a.type}: ${a.detail}`)
    }
  }

  await consume<Reading>('detect', TOPICS.readings, async (reading) => {
    const device = byId.get(reading.deviceId)
    if (!device) return

    const current = windows.get(reading.deviceId) ?? emptyWindow(reading.timestamp)
    const pushed = push(current, reading, RULES)
    const { anomalies: found, window } = evaluate(device, pushed, Date.now(), RULES)
    windows.set(reading.deviceId, window)
    await emit(found)
  })

  // Silence sweep. Every device is checked on a timer regardless of traffic —
  // this is the only way a device that has stopped talking gets noticed.
  const sweep = setInterval(async () => {
    const now = Date.now()
    for (const device of DEVICES) {
      const current = windows.get(device.deviceId)
      if (!current) continue
      const { anomalies: found, window } = evaluate(device, current, now, RULES)
      windows.set(device.deviceId, window)
      await emit(found)
    }
  }, config.sweepMs)

  onShutdown(async () => {
    clearInterval(sweep)
    await p.disconnect()
  })

  console.log(`detect: watching ${DEVICES.length} devices`)
}

main().catch((err) => {
  console.error('detect failed:', err)
  process.exit(1)
})
