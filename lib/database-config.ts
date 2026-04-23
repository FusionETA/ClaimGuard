type DatabaseConnectionConfig = {
  host: string
  port: number
  user: string
  password: string
  database: string
  ssl?: boolean | { rejectUnauthorized: boolean }
}

function parseBoolean(value: string | undefined) {
  if (!value) {
    return undefined
  }

  if (value === "true") {
    return true
  }

  if (value === "false") {
    return false
  }

  return undefined
}

function parseSslConfig(input: {
  sslMode?: string | null
  sslAccept?: string | null
  sslEnabled?: string
  rejectUnauthorized?: string
}) {
  const sslMode = input.sslMode?.toLowerCase()
  const sslAccept = input.sslAccept?.toLowerCase()
  const sslEnabled = parseBoolean(input.sslEnabled)
  const rejectUnauthorized = parseBoolean(input.rejectUnauthorized)

  if (sslAccept === "strict") {
    return true
  }

  if (sslAccept === "accept_invalid_certs") {
    return { rejectUnauthorized: false }
  }

  if (sslMode === "required" || sslMode === "require" || sslMode === "strict") {
    return true
  }

  if (sslMode === "accept_invalid_certs" || sslMode === "insecure") {
    return { rejectUnauthorized: false }
  }

  if (sslEnabled === true) {
    if (rejectUnauthorized === false) {
      return { rejectUnauthorized: false }
    }

    return true
  }

  return undefined
}

function parseUrlConnection() {
  const connectionUrl = process.env.DATABASE_URL

  if (!connectionUrl) {
    return null
  }

  try {
    const url = new URL(connectionUrl)
    return {
      host: url.hostname,
      port: Number(url.port || 3306),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: url.pathname.replace(/^\//, ""),
      ssl: parseSslConfig({
        sslMode: url.searchParams.get("sslmode"),
        sslAccept: url.searchParams.get("sslaccept"),
      }),
    }
  } catch {
    return null
  }
}

export function getDatabaseConnectionConfig(): DatabaseConnectionConfig | null {
  const parsed = parseUrlConnection()

  if (parsed?.host && parsed.user && parsed.password && parsed.database) {
    return parsed
  }

  if (
    process.env.DATABASE_HOST &&
    process.env.DATABASE_USER &&
    process.env.DATABASE_PASSWORD &&
    process.env.DATABASE_NAME
  ) {
    return {
      host: process.env.DATABASE_HOST,
      port: Number(process.env.DATABASE_PORT || 3306),
      user: process.env.DATABASE_USER,
      password: process.env.DATABASE_PASSWORD,
      database: process.env.DATABASE_NAME,
      ssl: parseSslConfig({
        sslMode: process.env.DATABASE_SSL_MODE ?? process.env.DATABASE_SSLMODE,
        sslEnabled: process.env.DATABASE_SSL,
        rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED,
      }),
    }
  }

  return null
}

export function isDatabaseConfigured() {
  return Boolean(getDatabaseConnectionConfig())
}
