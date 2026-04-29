import "server-only"

import { randomUUID } from "node:crypto"

const XERO_AUTHORIZE_URL = "https://login.xero.com/identity/connect/authorize"
const XERO_TOKEN_URL = "https://identity.xero.com/connect/token"
const XERO_CONNECTIONS_URL = "https://api.xero.com/connections"
const XERO_INVOICES_URL = "https://api.xero.com/api.xro/2.0/Invoices"
const XERO_ACCOUNTS_URL = "https://api.xero.com/api.xro/2.0/Accounts"
const XERO_PROJECTS_URL = "https://api.xero.com/projects.xro/2.0/projects"

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
  return process.env.XERO_SCOPES?.trim() || "offline_access accounting.transactions accounting.contacts"
}

export function getXeroDefaultAccountCode() {
  return process.env.XERO_DEFAULT_ACCOUNT_CODE?.trim() || ""
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
