import { MongoClient, type Db } from 'mongodb'
import { config } from './config.js'

let client: MongoClient | undefined

export async function db(): Promise<Db> {
  if (!client) {
    client = new MongoClient(config.mongoUrl)
    await client.connect()
  }
  return client.db(config.mongoDb)
}

export async function closeDb() {
  await client?.close()
  client = undefined
}
