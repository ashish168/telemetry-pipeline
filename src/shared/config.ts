export const config = {
  brokers: (process.env.KAFKA_BROKERS ?? 'localhost:19092').split(','),
  mongoUrl: process.env.MONGO_URL ?? 'mongodb://localhost:27017',
  mongoDb: process.env.MONGO_DB ?? 'telemetry',
  ingestPort: Number(process.env.INGEST_PORT ?? 3000),
  /** Simulated milliseconds between readings per device. */
  tickMs: Number(process.env.TICK_MS ?? 2000),
}
