// ── Device simulator ──
//
// Produces a continuous, plausible telemetry stream. The realism matters: a
// detector tuned against flat synthetic data falls apart on a real occupancy
// curve, so the simulator models the shape real building data actually has.
//
//   · daily occupancy curve      load rises through the morning, peaks mid-afternoon
//   · weekday / weekend split    weekends run at roughly a third of load
//   · per-device noise           sensors are never exactly repeatable
//   · seeded faults              see devices.ts
//
// Time is compressed — one simulated hour per tick — so a demo shows a full
// day within a couple of minutes.

import { onShutdown } from '../shared/bus.js'
import { type Reading } from '../shared/types.js'
import { config } from '../shared/config.js'
import { DEVICES, FAULTS } from './devices.js'

// Readings go through the ingest service over HTTP, exactly as a real device
// would send them — not straight onto the bus. Publishing directly would skip
// validation and persistence and leave ingest untested by the demo.
async function send(reading: Reading) {
  try {
    const res = await fetch(`${config.ingestUrl}/readings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(reading),
    })
    if (!res.ok) console.error(`ingest rejected ${reading.deviceId}: HTTP ${res.status}`)
  } catch (err) {
    console.error(`ingest unreachable: ${(err as Error).message}`)
  }
}

/** Occupancy 0..1 for a given hour. Flat overnight, humped through the day. */
function occupancy(hour: number, weekend: boolean): number {
  const base = Math.max(0, Math.sin(((hour - 6) / 14) * Math.PI))
  return weekend ? base * 0.3 : base
}

function value(kind: string, occ: number, mid: number, span: number): number {
  const noise = (Math.random() - 0.5) * span * 0.08
  // HVAC drifts up under load; a meter's draw is close to proportional to it.
  // Both stay comfortably inside the band: a healthy device must never trip a
  // detector, or the demo proves the opposite of what it claims.
  return kind === 'hvac' ? mid + occ * span * 0.35 + noise : mid * 0.72 + occ * span * 0.45 + noise
}

async function main() {
  onShutdown(async () => {})

  let simHour = 0
  // Tracks accumulated drift per device, so the fault builds gradually rather
  // than appearing as a step change.
  const drift = new Map<string, number>()

  console.log(`simulator: ${DEVICES.length} devices, tick ${config.tickMs}ms (1 simulated hour)`)

  setInterval(async () => {
    const hour = simHour % 24
    const weekend = Math.floor(simHour / 24) % 7 >= 5
    const occ = occupancy(hour, weekend)

    for (const d of DEVICES) {
      const fault = FAULTS[d.deviceId]
      const mid = (d.normalRange.min + d.normalRange.max) / 2
      const span = d.normalRange.max - d.normalRange.min

      // A silent device simply stops publishing after the first simulated day.
      // Nothing arrives — which is exactly what the detector has to notice.
      if (fault === 'silence' && simHour > 24) continue

      let v = value(d.kind, occ, mid, span)

      if (fault === 'spike' && hour >= 13 && hour <= 16) {
        v = d.normalRange.max + span * 0.5 + Math.random() * 2
      }
      if (fault === 'drift') {
        const accrued = (drift.get(d.deviceId) ?? 0) + span * 0.015
        drift.set(d.deviceId, accrued)
        v += accrued
      }

      const reading: Reading = {
        deviceId: d.deviceId,
        buildingId: d.buildingId,
        kind: d.kind,
        value: Number(v.toFixed(2)),
        unit: d.unit,
        timestamp: Date.now(),
      }
      await send(reading)
    }

    if (hour === 0) console.log(`simulator: day ${Math.floor(simHour / 24) + 1}${weekend ? ' (weekend)' : ''}`)
    simHour++
  }, config.tickMs)
}

main().catch((err) => {
  console.error('simulator failed:', err)
  process.exit(1)
})
