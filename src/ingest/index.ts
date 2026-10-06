// ── Ingest service ──
//
// Accepts readings over HTTP, validates them, and publishes to the bus. It does
// nothing else on purpose.
//
// Why this is its own service: ingest is latency-sensitive and bursty — devices
// retry when it is slow — while detection is CPU-bound over a window. Coupling
// them means an expensive detection pass applies backpressure to device
// check-ins, and you start losing readings precisely when something interesting
// is happening. Separating them lets each scale on its own axis.

import Fastify from 'fastify'
import { publish, producer, onShutdown } from '../shared/bus.js'
import { db } from '../shared/db.js'
import { TOPICS, type Reading } from '../shared/types.js'
import { config } from '../shared/config.js'

/** Rejects malformed payloads at the edge — nothing invalid reaches the bus. */
function parse(body: unknown): Reading | string {
  if (typeof body !== 'object' || body === null) return 'body must be an object'
  const r = body as Partial<Reading>
  if (!r.deviceId) return 'deviceId is required'
  if (!r.buildingId) return 'buildingId is required'
  if (typeof r.value !== 'number' || !Number.isFinite(r.value)) return 'value must be a finite number'
  if (typeof r.timestamp !== 'number') return 'timestamp must be epoch milliseconds'
  // Device clocks drift and occasionally reset. A reading far in the future is
  // a clock fault, not telemetry, and would poison a time-windowed detector.
  if (r.timestamp > Date.now() + 60_000) return 'timestamp is in the future — check the device clock'
  return r as Reading
}

async function main() {
  const app = Fastify({ logger: false })
  const p = await producer()
  const database = await db()
  const readings = database.collection<Reading>('readings')
  await readings.createIndex({ deviceId: 1, timestamp: -1 })

  app.post('/readings', async (req, reply) => {
    const parsed = parse(req.body)
    if (typeof parsed === 'string') return reply.code(400).send({ error: parsed })

    // Store then publish. A reading that is persisted but unprocessed can be
    // replayed; one that is processed but never stored is gone.
    await readings.insertOne({ ...parsed })
    await publish(p, TOPICS.readings, parsed.deviceId, parsed)
    return reply.code(202).send({ accepted: true })
  })

  app.get('/health', async () => ({ ok: true }))

  app.get('/readings/:deviceId', async (req) => {
    const { deviceId } = req.params as { deviceId: string }
    return readings.find({ deviceId }).sort({ timestamp: -1 }).limit(50).toArray()
  })

  onShutdown(async () => {
    await app.close()
    await p.disconnect()
  })

  await app.listen({ port: config.ingestPort, host: '0.0.0.0' })
  console.log(`ingest: listening on :${config.ingestPort}`)
}

main().catch((err) => {
  console.error('ingest failed:', err)
  process.exit(1)
})
