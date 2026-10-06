// ── End-to-end smoke test ──
//
// Drives the running stack through HTTP and asserts that all three detectors
// fire. Deliberately deterministic: it posts crafted readings rather than
// waiting on the simulator, so a CI failure means the pipeline is broken
// rather than that the run was unlucky.
//
// Expects ingest, detect and dispatch to be running, with SILENCE_MS and
// SWEEP_MS set low (see .github/workflows/ci.yml).

import { MongoClient } from 'mongodb'
import { DEVICES } from '../src/simulator/devices.js'
import { DEFAULT_RULES } from '../src/detect/rules.js'

const INGEST = process.env.INGEST_URL ?? 'http://localhost:3000'
const MONGO = process.env.MONGO_URL ?? 'mongodb://localhost:27017'
const DB = process.env.MONGO_DB ?? 'telemetry'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function post(deviceId: string, value: number) {
  const d = DEVICES.find((x) => x.deviceId === deviceId)!
  const res = await fetch(`${INGEST}/readings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      deviceId: d.deviceId,
      buildingId: d.buildingId,
      kind: d.kind,
      value,
      unit: d.unit,
      timestamp: Date.now(),
    }),
  })
  if (res.status !== 202) throw new Error(`ingest rejected ${deviceId}: HTTP ${res.status}`)
}

/** Poll until `check` passes or the budget runs out. Pipelines are async. */
async function waitFor(label: string, budgetMs: number, check: () => Promise<boolean>) {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (await check()) {
      console.log(`  ok   ${label}`)
      return
    }
    await sleep(1000)
  }
  throw new Error(`timed out waiting for: ${label}`)
}

async function main() {
  console.log(`e2e: ingest at ${INGEST}`)

  // Ingest must be up before anything else is meaningful.
  await waitFor('ingest is healthy', 60_000, async () => {
    try {
      return (await fetch(`${INGEST}/health`)).ok
    } catch {
      return false
    }
  })

  const client = await new MongoClient(MONGO).connect()
  const anomalies = client.db(DB).collection('anomalies')
  const commands = client.db(DB).collection('commands')
  const has = (q: object) => async () => (await anomalies.countDocuments(q)) > 0

  // ── Rejects bad input ──
  const bad = await fetch(`${INGEST}/readings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId: 'hvac-a-01' }), // no value, no timestamp
  })
  if (bad.status !== 400) throw new Error(`expected 400 for malformed reading, got ${bad.status}`)
  console.log('  ok   malformed readings are rejected at the edge')

  // ── Threshold breach: three consecutive readings above the band ──
  for (const v of [31, 32, 33]) {
    await post('hvac-a-01', v)
    await sleep(150)
  }
  await waitFor('threshold_breach detected', 30_000,
    has({ deviceId: 'hvac-a-01', type: 'threshold_breach' }))

  // ── Drift: establish this device's baseline, then move away from it ──
  // Drift is relative to the device's own normal, so the baseline has to exist
  // before a shift means anything.
  for (let i = 0; i < DEFAULT_RULES.baselineSize; i++) {
    await post('meter-a-01', 50)
    await sleep(15)
  }
  for (let i = 0; i < DEFAULT_RULES.windowSize; i++) {
    await post('meter-a-01', 75)
    await sleep(15)
  }
  await waitFor('sensor_drift detected', 30_000,
    has({ deviceId: 'meter-a-01', type: 'sensor_drift' }))

  // ── Silence: report once, then stop, and let the sweep notice ──
  await post('hvac-b-01', 23)
  await waitFor('device_silent detected', 60_000,
    has({ deviceId: 'hvac-b-01', type: 'device_silent' }))

  // ── Dispatch turned anomalies into commands ──
  await waitFor('dispatch issued commands', 30_000,
    async () => (await commands.countDocuments({})) > 0)

  const [a, c] = [await anomalies.countDocuments({}), await commands.countDocuments({})]
  console.log(`\ne2e passed — ${a} anomalies, ${c} commands`)
  await client.close()
}

main().catch(async (err) => {
  console.error(`\ne2e FAILED: ${err.message}`)
  process.exit(1)
})
