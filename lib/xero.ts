import "server-only"

import { randomUUID } from "node:crypto"

const XERO_AUTHORIZE_URL = "https://login.xero.com/identity/connect/authorize"
const XERO_TOKEN_URL = "https://identity.xero.com/connect/token"
const XERO_CONNECTIONS_URL = "https://api.xero.com/connections"
const XERO_INVOICES_URL = "https://api.xero.com/api.xro/2.0/Invoices"
const XERO_ACCOUNTS_URL = "https://api.xero.com/api.xro/2.0/Accounts"
const XERO_PROJECTS_URL = "https://api.xero.com/projects.xro/2.0/projects"
const XERO_FILES_BASE_URL = "https://api.xero.com/files.xro/1.0"
/// Top-level folder name used for receipt uploads from this app. The
/// folder is created once per tenant on first upload; subsequent uploads
/// reuse it.
const XERO_FILES_FOLDER_NAME = "Claims"

export type XeroTokenSet = {
  accessToken: string
  refreshToken: string
  scope: string
  tokenType: string
  expiresAt: Date
}

export type XeroTenant = {
  /** Xero connection ID — used to revoke the connection via DELETE /connections/{connectionId} */
  connectionId: string
  tenantId: string
  tenantName: string
  tenantType?: string
}

export type XeroBillPayload = {
  contactName: string
  contactEmail?: string
  date: string
  dueDate: string
  currency: string
  amount: number
  description: string
  reference: string
}

export type XeroAccount = {
  xeroAccountId: string
  code: string
  name: string
  type?: string
  status?: string
}

export type XeroProject = {
  xeroProjectId: string
  name: string
  status?: string
  contactId?: string
}

type XeroTokenResponse = {
  access_token: string
  expires_in: number
  refresh_token: string
  scope: string
  token_type: string
}

function getRequiredEnv(name: string) {
  const value = process.env[name]

  if (!value) {
    throw new Error(`Missing required Xero environment variable: ${name}`)
  }

  return value
}

export function getXeroScopes() {
  // `files` is required for the Xero Files API (folder + file upload +
  // file content + invoice association). Existing connections issued
  // before this scope was added need to disconnect and reconnect Xero
  // for the new scope to be granted on the access token.
  return (
    process.env.XERO_SCOPES?.trim() ||
    "offline_access accounting.transactions accounting.contacts accounting.attachments files"
  )
}

/**
 * Developer-controlled re-authorization tag. When this env var is set,
 * connections whose `lastReauthVersion` column does not match the current
 * value will display an "Update permissions" button in the admin UI.
 * Bump this string any time you ship a release that requires a wider
 * scope set (or any other change that needs the admin to re-run the
 * OAuth flow). After each successful callback we persist this same value
 * back into `lastReauthVersion`, which hides the button for that
 * connection until the next bump. Empty / unset disables the feature
 * entirely.
 */
export function getXeroReauthVersion(): string | null {
  const raw = process.env.XERO_REAUTH_VERSION?.trim()
  return raw && raw.length > 0 ? raw : null
}

export function getXeroRuntimeConfigStatus() {
  return {
    configured: Boolean(
      process.env.XERO_CLIENT_ID &&
        process.env.XERO_CLIENT_SECRET &&
        process.env.XERO_REDIRECT_URI
    ),
    missing: [
      !process.env.XERO_CLIENT_ID ? "XERO_CLIENT_ID" : null,
      !process.env.XERO_CLIENT_SECRET ? "XERO_CLIENT_SECRET" : null,
      !process.env.XERO_REDIRECT_URI ? "XERO_REDIRECT_URI" : null,
    ].filter(Boolean) as string[],
  }
}

function getClientCredentialsHeader() {
  const clientId = getRequiredEnv("XERO_CLIENT_ID")
  const clientSecret = getRequiredEnv("XERO_CLIENT_SECRET")

  return Buffer.from(`${clientId}:${clientSecret}`).toString("base64")
}

function buildTokenSet(data: XeroTokenResponse): XeroTokenSet {
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    scope: data.scope,
    tokenType: data.token_type,
    expiresAt: new Date(Date.now() + data.expires_in * 1000),
  }
}

async function parseXeroResponse(response: Response) {
  const text = await response.text()

  if (!text) {
    return null
  }

  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

async function requestToken(body: URLSearchParams): Promise<XeroTokenSet> {
  const response = await fetch(XERO_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${getClientCredentialsHeader()}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
    cache: "no-store",
  })

  if (!response.ok) {
    const errorBody = await parseXeroResponse(response)
    throw new Error(
      `Xero token request failed with ${response.status}: ${JSON.stringify(errorBody)}`
    )
  }

  const json = (await response.json()) as XeroTokenResponse
  return buildTokenSet(json)
}

export function createXeroOauthState() {
  return randomUUID()
}

export function getXeroAuthorizationUrl(state: string) {
  const redirectUri = getRequiredEnv("XERO_REDIRECT_URI")
  const clientId = getRequiredEnv("XERO_CLIENT_ID")
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: getXeroScopes(),
    state,
  })

  return `${XERO_AUTHORIZE_URL}?${params.toString()}`
}

export async function exchangeXeroCodeForTokens(code: string) {
  const redirectUri = getRequiredEnv("XERO_REDIRECT_URI")

  return requestToken(
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    })
  )
}

export async function refreshXeroToken(refreshToken: string) {
  return requestToken(
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    })
  )
}

export async function getXeroTenants(accessToken: string): Promise<XeroTenant[]> {
  const response = await fetch(XERO_CONNECTIONS_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
    cache: "no-store",
  })

  if (!response.ok) {
    const errorBody = await parseXeroResponse(response)
    throw new Error(
      `Xero connections request failed with ${response.status}: ${JSON.stringify(errorBody)}`
    )
  }

  const json = (await response.json()) as Array<{
    id: string
    tenantId: string
    tenantName: string
    tenantType?: string
  }>

  return json.map((tenant) => ({
    connectionId: tenant.id,
    tenantId: tenant.tenantId,
    tenantName: tenant.tenantName,
    tenantType: tenant.tenantType,
  }))
}

export async function deleteXeroConnection(accessToken: string, connectionId: string): Promise<void> {
  const response = await fetch(`${XERO_CONNECTIONS_URL}/${connectionId}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
    cache: "no-store",
  })

  // 204 = success, 404 = already gone — both are fine
  if (!response.ok && response.status !== 404) {
    const errorBody = await parseXeroResponse(response)
    throw new Error(
      `Xero connection delete failed with ${response.status}: ${JSON.stringify(errorBody)}`
    )
  }
}

export async function getXeroAccounts({
  accessToken,
  tenantId,
}: {
  accessToken: string
  tenantId: string
}): Promise<XeroAccount[]> {
  const response = await fetch(XERO_ACCOUNTS_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "xero-tenant-id": tenantId,
    },
    cache: "no-store",
  })

  if (!response.ok) {
    const errorBody = await parseXeroResponse(response)
    throw new Error(
      `Xero accounts request failed with ${response.status}: ${JSON.stringify(errorBody)}`
    )
  }

  const json = (await response.json()) as {
    Accounts?: Array<{
      AccountID?: string
      Code?: string
      Name?: string
      Type?: string
      Status?: string
      EnablePaymentsToAccount?: boolean
      ShowInExpenseClaims?: boolean
    }>
  }

  return (json.Accounts ?? [])
    .filter((account) => {
      if (!account.AccountID || !account.Code || !account.Name) {
        return false
      }

      if (account.Status && account.Status !== "ACTIVE") {
        return false
      }

      // EXPENSE → Claim accounts tab. BANK → Bank accounts tab.
      return account.Type === "EXPENSE" || account.Type === "BANK"
    })
    .map((account) => ({
      xeroAccountId: account.AccountID as string,
      code: account.Code as string,
      name: account.Name as string,
      type: account.Type,
      status: account.Status,
    }))
}

export async function getXeroProjects({
  accessToken,
  tenantId,
}: {
  accessToken: string
  tenantId: string
}): Promise<XeroProject[]> {
  const response = await fetch(XERO_PROJECTS_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "xero-tenant-id": tenantId,
    },
    cache: "no-store",
  })

  if (!response.ok) {
    const errorBody = await parseXeroResponse(response)
    throw new Error(
      `Xero projects request failed with ${response.status}: ${JSON.stringify(errorBody)}`
    )
  }

  const json = (await response.json()) as {
    items?: Array<{
      projectId?: string
      name?: string
      status?: string
      contactId?: string
    }>
    Projects?: Array<{
      ProjectID?: string
      Name?: string
      Status?: string
      ContactID?: string
    }>
  }

  const rows =
    json.items?.map((item) => ({
      projectId: item.projectId,
      name: item.name,
      status: item.status,
      contactId: item.contactId,
    })) ??
    json.Projects?.map((item) => ({
      projectId: item.ProjectID,
      name: item.Name,
      status: item.Status,
      contactId: item.ContactID,
    })) ??
    []

  return rows
    .filter((project) => project.projectId && project.name)
    .map((project) => ({
      xeroProjectId: project.projectId as string,
      name: project.name as string,
      status: project.status,
      contactId: project.contactId,
    }))
}

export async function createXeroBill({
  accessToken,
  tenantId,
  payload,
  idempotencyKey,
}: {
  accessToken: string
  tenantId: string
  payload: XeroBillPayload
  idempotencyKey: string
}) {
  const accountCode = getRequiredEnv("XERO_DEFAULT_ACCOUNT_CODE")

  const response = await fetch(XERO_INVOICES_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      "xero-tenant-id": tenantId,
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify({
      Invoices: [
        {
          Type: "ACCPAY",
          Status: "DRAFT",
          Contact: {
            Name: payload.contactName,
            EmailAddress: payload.contactEmail,
          },
          Date: payload.date,
          DueDate: payload.dueDate,
          CurrencyCode: payload.currency,
          Reference: payload.reference,
          LineAmountTypes: "Exclusive",
          LineItems: [
            {
              Description: payload.description,
              Quantity: 1,
              UnitAmount: payload.amount,
              AccountCode: accountCode,
            },
          ],
        },
      ],
    }),
    cache: "no-store",
  })

  if (!response.ok) {
    const errorBody = await parseXeroResponse(response)
    throw new Error(
      `Xero bill creation failed with ${response.status}: ${JSON.stringify(errorBody)}`
    )
  }

  const json = (await response.json()) as {
    Invoices?: Array<{
      InvoiceID?: string
      InvoiceNumber?: string
    }>
  }

  const invoice = json.Invoices?.[0]

  if (!invoice?.InvoiceID) {
    throw new Error("Xero bill creation succeeded but no InvoiceID was returned.")
  }

  return {
    invoiceId: invoice.InvoiceID,
    invoiceNumber: invoice.InvoiceNumber,
  }
}

// ---------------------------------------------------------------------------
// Xero Files API
// ---------------------------------------------------------------------------
//
// Used to upload claim receipts to a tenant's Xero Files. The flow is:
//   1. getOrCreateClaimsFolder(...)          → returns the folder id
//   2. uploadFileToXero(...)                 → returns the file id + meta
//   3. associateFileWithInvoice(...)         → links the file to the bill
//      created via createXeroBill
//
// Receipt downloads from the browser go through a server-side proxy (so
// the access token never reaches the client) — see
// app/api/xero/files/[fileId]/content/route.ts. That route uses
// getXeroFileContent below.

export type XeroFileUploadResult = {
  fileId: string
  fileName: string
  mimeType?: string
  size?: number
  folderId?: string
}

/**
 * Look up — or create — the "Claims" folder in the given Xero tenant.
 * Falls back to undefined when folder access is forbidden so callers can
 * upload to the inbox instead. Throws on unexpected errors.
 */
async function getOrCreateXeroFolder({
  accessToken,
  tenantId,
  folderName,
}: {
  accessToken: string
  tenantId: string
  folderName: string
}): Promise<string | undefined> {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "Xero-tenant-id": tenantId,
    Accept: "application/json",
  }

  const listResp = await fetch(`${XERO_FILES_BASE_URL}/Folders`, {
    method: "GET",
    headers,
  })
  if (listResp.ok) {
    const folders = (await listResp.json()) as Array<{ Id?: string; Name?: string }>
    const existing = folders.find((f) => f.Name === folderName)
    if (existing?.Id) return existing.Id
  } else if (listResp.status === 401 || listResp.status === 403) {
    // Tenant didn't grant Files scope. Caller should fall back to
    // uploading without a folder (Xero inbox).
    return undefined
  } else {
    const text = await listResp.text().catch(() => "")
    throw new Error(`Xero list folders failed: ${listResp.status} ${text}`)
  }

  // Not found — create it.
  const createResp = await fetch(`${XERO_FILES_BASE_URL}/Folders`, {
    method: "POST",
    headers: {
      ...headers,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ Name: folderName }),
  })
  if (!createResp.ok) {
    const text = await createResp.text().catch(() => "")
    // Treat 4xx as a soft failure (e.g. folder limits). Caller will
    // upload without a folder.
    if (createResp.status >= 400 && createResp.status < 500) return undefined
    throw new Error(`Xero create folder failed: ${createResp.status} ${text}`)
  }
  const created = (await createResp.json()) as { Id?: string }
  return created.Id
}

export async function getOrCreateClaimsFolder(args: {
  accessToken: string
  tenantId: string
}): Promise<string | undefined> {
  return getOrCreateXeroFolder({ ...args, folderName: XERO_FILES_FOLDER_NAME })
}

const XERO_ATTENDANCE_SELFIE_FOLDER_NAME = "Attendance Selfie"

export async function getOrCreateAttendanceSelfieFolder(args: {
  accessToken: string
  tenantId: string
}): Promise<string | undefined> {
  return getOrCreateXeroFolder({
    ...args,
    folderName: XERO_ATTENDANCE_SELFIE_FOLDER_NAME,
  })
}

/**
 * Delete a file from Xero Files. Throws on non-2xx so the caller (e.g.
 * the retention cron) can log per-file failures and keep going.
 */
export async function deleteXeroFile({
  accessToken,
  tenantId,
  fileId,
}: {
  accessToken: string
  tenantId: string
  fileId: string
}): Promise<void> {
  const resp = await fetch(`${XERO_FILES_BASE_URL}/Files/${fileId}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Xero-tenant-id": tenantId,
    },
  })
  // 404 means the file is already gone — treat as success so reruns
  // don't spam errors.
  if (resp.ok || resp.status === 404) return
  const text = await resp.text().catch(() => "")
  throw new Error(`Xero file delete failed: ${resp.status} ${text}`)
}

/**
 * Upload a file (receipt) into the given folder, or into the Xero Files
 * inbox when folderId is undefined. Returns the Xero file id and basic
 * metadata.
 */
export async function uploadFileToXero({
  accessToken,
  tenantId,
  folderId,
  fileBuffer,
  fileName,
  mimeType,
}: {
  accessToken: string
  tenantId: string
  folderId?: string
  fileBuffer: Buffer
  fileName: string
  mimeType: string
}): Promise<XeroFileUploadResult> {
  const safeName = sanitizeFilename(fileName)
  const url = folderId
    ? `${XERO_FILES_BASE_URL}/Files/${folderId}`
    : `${XERO_FILES_BASE_URL}/Files`

  const boundary = `----xero-files-boundary-${randomUUID()}`
  const CRLF = "\r\n"
  const head =
    `--${boundary}${CRLF}` +
    `Content-Disposition: form-data; name="${safeName}"; filename="${safeName}"${CRLF}` +
    `Content-Type: ${mimeType}${CRLF}${CRLF}`
  const tail = `${CRLF}--${boundary}--${CRLF}`

  const body = Buffer.concat([
    Buffer.from(head, "utf-8"),
    fileBuffer,
    Buffer.from(tail, "utf-8"),
  ])

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Xero-tenant-id": tenantId,
      Accept: "application/json",
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    },
    body,
  })
  if (!response.ok) {
    const text = await response.text().catch(() => "")
    throw new Error(`Xero file upload failed: ${response.status} ${text}`)
  }
  const json = (await response.json()) as {
    Id?: string
    Name?: string
    MimeType?: string
    Size?: number
    FolderId?: string
  }
  if (!json.Id) {
    throw new Error("Xero file upload succeeded but no Id was returned.")
  }
  return {
    fileId: json.Id,
    fileName: json.Name ?? safeName,
    mimeType: json.MimeType,
    size: json.Size,
    folderId: json.FolderId,
  }
}

/**
 * Stream a file's binary content from Xero Files. Returns the body
 * buffer plus the content type, so the caller (the proxy route) can
 * pass them straight through to the browser.
 */
export async function getXeroFileContent({
  accessToken,
  tenantId,
  fileId,
}: {
  accessToken: string
  tenantId: string
  fileId: string
}): Promise<{ body: ArrayBuffer; contentType: string; contentLength?: number }> {
  const response = await fetch(
    `${XERO_FILES_BASE_URL}/Files/${fileId}/Content`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Xero-tenant-id": tenantId,
      },
    },
  )
  if (!response.ok) {
    const text = await response.text().catch(() => "")
    throw new Error(`Xero file content fetch failed: ${response.status} ${text}`)
  }
  const contentType = response.headers.get("content-type") ?? "application/octet-stream"
  const contentLengthRaw = response.headers.get("content-length")
  const contentLength = contentLengthRaw ? Number(contentLengthRaw) : undefined
  const body = await response.arrayBuffer()
  return { body, contentType, contentLength }
}

/**
 * Associate a previously uploaded Xero file with an invoice (a bill in
 * Accounts Payable terms). Soft-fails on 4xx so a partial sync doesn't
 * block claim approval.
 */
export async function associateFileWithInvoice({
  accessToken,
  tenantId,
  fileId,
  invoiceId,
}: {
  accessToken: string
  tenantId: string
  fileId: string
  invoiceId: string
}): Promise<void> {
  const response = await fetch(
    `${XERO_FILES_BASE_URL}/Files/${fileId}/Associations`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Xero-tenant-id": tenantId,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ObjectId: invoiceId,
        // Xero treats supplier bills as ACCPAY invoices, so the group
        // here is still "Invoice".
        ObjectGroup: "Invoice",
      }),
    },
  )
  if (!response.ok) {
    const text = await response.text().catch(() => "")
    throw new Error(`Xero file association failed: ${response.status} ${text}`)
  }
}

/// Strip path separators and dangerous characters from a filename so it
/// can be safely used in a Content-Disposition header. Falls back to a
/// generic name if all characters are stripped.
function sanitizeFilename(name: string): string {
  const cleaned = name
    .replace(/[\\/\r\n]+/g, "-")
    .replace(/[^\w.\-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 200)
  return cleaned || "receipt.bin"
}
