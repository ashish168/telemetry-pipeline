// ── Kafka access ──
// Thin wrapper so each service's main file reads as domain logic rather than
// broker ceremony. Deliberately not an abstraction over "messaging" — there is
// one broker and there is no second implementation coming.

import { Kafka, logLevel, type Consumer, type Producer } from 'kafkajs'
import { config } from './config.js'

const kafka = new Kafka({ clientId: 'telemetry', brokers: config.brokers, logLevel: logLevel.ERROR })

export async function producer(): Promise<Producer> {
  const p = kafka.producer()
  await p.connect()
  return p
}

export async function publish<T>(p: Producer, topic: string, key: string, value: T) {
  await p.send({ topic, messages: [{ key, value: JSON.stringify(value) }] })
}

/**
 * Consume a topic, decoding JSON and handing each message to `onMessage`.
 * A handler that throws logs and continues — one poisoned message must not
 * stop the stream.
 */
export async function consume<T>(
  groupId: string,
  topic: string,
  onMessage: (value: T) => Promise<void> | void,
): Promise<Consumer> {
  const c = kafka.consumer({ groupId })
  await c.connect()
  await c.subscribe({ topic, fromBeginning: false })
  await c.run({
    eachMessage: async ({ message }) => {
      if (!message.value) return
      try {
        await onMessage(JSON.parse(message.value.toString()) as T)
      } catch (err) {
        console.error(`[${groupId}] handler failed:`, err)
      }
    },
  })
  return c
}

/** Shut down cleanly on Ctrl-C so consumer groups rebalance promptly. */
export function onShutdown(fn: () => Promise<void>) {
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      fn()
        .catch(() => {})
        .finally(() => process.exit(0))
    })
  }
}
