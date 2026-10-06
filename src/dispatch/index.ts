// ── Dispatch service ──
//
// Consumes anomalies and decides what to do about them. Separated from detection
// because "what is wrong" and "what should happen about it" change for different
// reasons and on different timescales: detection thresholds are tuned by
// engineers, response policy is set by operations.

import { consume, publish, producer, onShutdown } from '../shared/bus.js'
import { db } from '../shared/db.js'
import { TOPICS, type Anomaly, type Command } from '../shared/types.js'

/** Response policy. The only place that decides what an anomaly *means*. */
function decide(a: Anomaly): Command {
  const base = { deviceId: a.deviceId, buildingId: a.buildingId, issuedAt: Date.now() }
  switch (a.type) {
    case 'threshold_breach':
      // Something actionable is happening now — adjust if we can, escalate if severe.
      return a.severity === 'critical'
        ? { ...base, action: 'notify_operator', reason: `Critical breach: ${a.detail}` }
        : { ...base, action: 'setpoint_adjust', reason: a.detail }
    case 'sensor_drift':
      // Nothing to actuate. The instrument is suspect, so a human should look.
      return { ...base, action: 'flag_for_inspection', reason: `Calibration suspect: ${a.detail}` }
    case 'device_silent':
      return { ...base, action: 'notify_operator', reason: `Device unreachable: ${a.detail}` }
  }
}

async function main() {
  const p = await producer()
  const commands = (await db()).collection<Command>('commands')

  await consume<Anomaly>('dispatch', TOPICS.anomalies, async (anomaly) => {
    const command = decide(anomaly)
    await commands.insertOne({ ...command })
    await publish(p, TOPICS.commands, command.deviceId, command)
    console.log(`-> ${command.deviceId} ${command.action}: ${command.reason}`)
  })

  onShutdown(async () => {
    await p.disconnect()
  })

  console.log('dispatch: listening for anomalies')
}

main().catch((err) => {
  console.error('dispatch failed:', err)
  process.exit(1)
})
