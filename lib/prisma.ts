import { PrismaMariaDb } from "@prisma/adapter-mariadb"

import { getDatabaseConnectionConfig } from "@/lib/database-config"

import { PrismaClient } from "@/generated/prisma/client"

declare global {
  // eslint-disable-next-line no-var
  var prismaClientSingleton: PrismaClient | undefined
}

function createPrismaClient() {
  const config = getDatabaseConnectionConfig()

  if (!config) {
    return null
  }

  const adapter = new PrismaMariaDb({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    connectionLimit: 15,
    ssl: config.ssl,
    // --- Connection reliability for remote/cloud DBs (DigitalOcean, PlanetScale, etc.) ---
    // Ping a connection that has been idle for >500ms before handing it out.
    // This detects connections the server has silently closed and triggers a reconnect.
    minDelayValidation: 500,
    // Remove connections that have been idle for more than 60 seconds from the pool.
    // DigitalOcean managed MySQL drops idle TCP connections; this prevents the pool
    // from handing out those dead connections on the next request.
    idleTimeout: 60,
    // Wait at most 10s when trying to establish a new TCP connection.
    connectTimeout: 10000,
    // If all connections are busy, wait at most 15s before throwing an error.
    // Without this, requests can queue indefinitely and hang the page.
    acquireTimeout: 15000,
  })

  return new PrismaClient({
    adapter,
  })
}

export function getPrismaClient() {
  if (globalThis.prismaClientSingleton) {
    return globalThis.prismaClientSingleton
  }

  const client = createPrismaClient()

  if (client) {
    globalThis.prismaClientSingleton = client
  }

  return client
}
