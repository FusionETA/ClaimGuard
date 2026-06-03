import "server-only"

import { randomUUID } from "node:crypto"

const XERO_AUTHORIZE_URL = "https://login.xero.com/identity/connect/authorize"
const XERO_TOKEN_URL = "https://identity.xero.com/connect/token"
const XERO_CONNECTIONS_URL = "https://api.xero.com/connections"
const XERO_INVOICES_URL = "https://api.xero.com/api.xro/2.0/Invoices"
const XERO_BANK_TRANSACTIONS_URL =
  "https://api.xero.com/api.xro/2.0/BankTransactions"
const XERO_MANUAL_JOURNALS_URL =
  "https://api.xero.com/api.xro/2.0/ManualJournals"
const XERO_ACCOUNTS_URL = "https://api.xero.com/api.xro/2.0/Accounts"
const XERO_PROJECTS_URL = "https://api.xero.com/projects.xro/2.0/projects"
const XERO_TRACKING_CATEGORIES_URL =
  "https://api.xero.com/api.xro/2.0/TrackingCategories"
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
  /**
   * Xero account CODE (e.g. "453") for the line. Optional — when not
   * provided, the legacy `XERO_DEFAULT_ACCOUNT_CODE` env var is used.
   * New code paths should always pass this from the claim's
   * `chartOfAccount.code`.
   */
  accountCode?: string
  /**
   * Optional tracking dimension stamped on the line. Up to two
   * tracking entries per line are allowed by Xero. The wizard uses
   * this for the project dimension; pass `{ name: "<Tracking
   * Category Name>", option: "<Tracking Option Name>" }`.
   */
  tracking?: Array<{ name: string; option: string }>
}

/**
 * Payload for a "Spend Money" bank transaction — used for COMPANY-money
 * claims where the money has ALREADY left the company bank/card (so it's
 * a completed spend, not an awaiting-payment bill). Differs from
 * `XeroBillPayload` in that it carries the source `bankAccountCode`
 * (where the money came from) and has no due date (it's not a payable).
 */
export type XeroSpendMoneyPayload = {
  contactName: string
  contactEmail?: string
  date: string
  /// Kept for caller context, but not sent to Xero for normal SPEND
  /// transactions. Xero only accepts CurrencyCode for overpayments.
  currency: string
  amount: number
  description: string
  reference: string
  /** Xero account CODE of the EXPENSE account the spend is categorised to. */
  accountCode: string
  /** Xero account CODE of the BANK account the money was paid from. */
  bankAccountCode: string
  /** Optional project tracking, same semantics as the bill payload. */
  tracking?: Array<{ name: string; option: string }>
}

export type XeroAccount = {
  xeroAccountId: string
  code: string
  name: string
  type?: string
  status?: string
  systemAccount?: string
}

export type XeroProject = {
  xeroProjectId: string
  name: string
  status?: string
  contactId?: string
}

/**
 * One option within a Xero Tracking Category. Matches the shape
 * returned by GET TrackingCategories under `Options[]`. We strip the
 * camelCase noise and only surface the four fields we actually use
 * (the others — HasValidationErrors / IsDeleted etc. — are not
 * useful for our "project list" projection).
 */
export type XeroTrackingOption = {
  xeroTrackingOptionId: string
  name: string
  /// "ACTIVE" | "ARCHIVED" per Xero status codes. Archived options
  /// are filtered out by default by `getXeroTrackingCategories`.
  status: string
}

/**
 * One tracking category with its options. Matches the response shape
 * of GET TrackingCategories — categories come back with their options
 * already nested, so one round-trip serves both the settings picker
 * (admin chooses a category) AND the sync (we pull options from the
 * chosen category).
 */
export type XeroTrackingCategory = {
  xeroTrackingCategoryId: string
  name: string
  /// "ACTIVE" | "ARCHIVED". Archived categories are filtered out by
  /// default by the fetcher.
  status: string
  options: XeroTrackingOption[]
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
  // Scopes summary:
  //   • `offline_access`            — refresh tokens (mandatory).
  //   • `accounting.invoices`       — bills / invoices.
  //   • `accounting.banktransactions` — Spend Money / Receive Money.
  //   • `accounting.manualjournals` — manual journals (separate scope
  //                                    on the Xero side; payroll runs
  //                                    sync as manual journals).
  //   • `accounting.contacts`       — bill contact (employee) records.
  //   • `accounting.settings`       — accounts + tracking categories.
  //   • `accounting.attachments`    — attach receipts to bills.
  //   • `files`                     — Xero Files API for uploading
  //                                    receipts.
  //
  // Existing connections issued before any of these scopes were added
  // need to disconnect and reconnect Xero for the new scope to be
  // granted on the access token. The `XERO_REAUTH_VERSION` tag bumps
  // when scopes change so admins see an "Update permissions" prompt
  // on their Xero connection.
  return (
    process.env.XERO_SCOPES?.trim() ||
    "openid profile email offline_access accounting.invoices accounting.banktransactions accounting.contacts accounting.settings accounting.manualjournals projects files"
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
/**
 * Built-in fallback tag for the reauth prompt. Bump whenever the
 * default scope set in `getXeroScopes()` changes so existing
 * connections automatically show "Update permissions" without the
 * admin having to set `XERO_REAUTH_VERSION` in env.
 *
 * Format: YYYY-MM-DD-<short-reason>. Use the date of the deploy
 * that ships the new scope set.
 */
const DEFAULT_REAUTH_VERSION = "2026-05-22-banktransactions-scope"

export function getXeroReauthVersion(): string | null {
  // Env override wins so admins can force a re-auth even when no
  // scope change shipped (e.g. revoking suspect tokens).
  const raw = process.env.XERO_REAUTH_VERSION?.trim()
  if (raw && raw.length > 0) return raw
  return DEFAULT_REAUTH_VERSION
}

export function getXeroRuntimeConfigStatus() {
  return {
    configured: Boolean(
      process.env.XERO_CLIENT_ID && process.env.XERO_CLIENT_SECRET
    ),
    missing: [
      !process.env.XERO_CLIENT_ID ? "XERO_CLIENT_ID" : null,
      !process.env.XERO_CLIENT_SECRET ? "XERO_CLIENT_SECRET" : null,
    ].filter(Boolean) as string[],
  }
}

/**
 * Build the OAuth callback URI for a given request origin. Both the
 * initial auth-request URI and the token-exchange URI must be byte
 * identical, or Xero rejects the token call with `invalid_grant`.
 * Centralising the construction here means there's exactly one shape
 * we ever send to Xero (`{origin}/api/xero/callback`).
 *
 * Both routes derive `requestOrigin` from `getRequestOrigin(request)`,
 * which honours `x-forwarded-host` so it picks up the public hostname
 * (e.g. `hr.altomate.io`) behind the proxy rather than `localhost:3000`.
 * Xero only redirects the user back to the URI we sent in step 1, so
 * the callback request lands on the same host and step 2 produces the
 * identical URI automatically.
 *
 * Every host you serve from must be registered as an allowed redirect
 * URI in the Xero Developer Portal — Xero supports multiple per app.
 */
export function buildXeroRedirectUri(requestOrigin: string): string {
  return `${requestOrigin.replace(/\/+$/, "")}/api/xero/callback`
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

function collectXeroValidationMessages(value: unknown): string[] {
  const messages: string[] = []
  const visit = (node: unknown) => {
    if (!node || typeof node !== "object") return
    const record = node as Record<string, unknown>
    if (typeof record.Message === "string" && record.Message.trim()) {
      messages.push(record.Message.trim())
    }
    for (const key of [
      "ValidationErrors",
      "Elements",
      "JournalLines",
      "BankTransactions",
      "LineItems",
      "Invoices",
    ] as const) {
      const child = record[key]
      if (Array.isArray(child)) {
        for (const item of child) visit(item)
      }
    }
  }
  visit(value)
  return Array.from(new Set(messages)).filter(
    (message) => message !== "A validation exception occurred",
  )
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

export function getXeroAuthorizationUrl(input: {
  state: string
  /** Host-aware origin from `getRequestOrigin(request)`. The redirect
   *  URI we hand to Xero is built from this so multi-domain deployments
   *  (e.g. `hr.altomate.io` AND `altomatehr.fusioneta.com.my`) all work
   *  with one app config. */
  requestOrigin: string
}) {
  const redirectUri = buildXeroRedirectUri(input.requestOrigin)
  const clientId = getRequiredEnv("XERO_CLIENT_ID")
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: getXeroScopes(),
    state: input.state,
  })

  return `${XERO_AUTHORIZE_URL}?${params.toString()}`
}

export async function exchangeXeroCodeForTokens(input: {
  code: string
  /** Same `getRequestOrigin(request)` value as the auth-URL build. Xero
   *  redirects the user back to the URI we sent in step 1, so the
   *  callback request lands on that same host — passing it here keeps
   *  the URIs byte-identical, which Xero requires. */
  requestOrigin: string
}) {
  const redirectUri = buildXeroRedirectUri(input.requestOrigin)

  return requestToken(
    new URLSearchParams({
      grant_type: "authorization_code",
      code: input.code,
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

/**
 * Resolve a Xero connection ID from a tenant ID by calling GET /connections.
 * Used by the disconnect flow when the local row was created before the
 * `xeroConnectionId` column was added — `tenantId` is NOT a valid input to
 * `DELETE /connections/{id}` (Xero looks that up by connection ID, not
 * tenant ID, and silently 404s on mismatch).
 *
 * Returns `null` if Xero doesn't know about the tenant any more (token
 * already revoked, tenant disconnected from the app on Xero's side, etc.) —
 * callers should treat that as "already gone" and proceed with local cleanup.
 */
export async function findXeroConnectionIdForTenant(
  accessToken: string,
  tenantId: string,
): Promise<string | null> {
  try {
    const tenants = await getXeroTenants(accessToken)
    const match = tenants.find((t) => t.tenantId === tenantId)
    return match?.connectionId ?? null
  } catch {
    // Token expired / Xero unreachable — disconnect should still clean up locally.
    return null
  }
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
  includeTypes = ["EXPENSE", "BANK"],
}: {
  accessToken: string
  tenantId: string
  includeTypes?: string[]
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
      SystemAccount?: string
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

      // EXPENSE → Claim/payroll account tabs. BANK → Bank accounts tab.
      // Xero system accounts can appear as EXPENSE (e.g. Bank
      // Revaluations), but the Manual Journal API rejects them.
      if (account.SystemAccount) {
        return false
      }
      return Boolean(account.Type && includeTypes.includes(account.Type))
    })
    .map((account) => ({
      xeroAccountId: account.AccountID as string,
      code: account.Code as string,
      name: account.Name as string,
      type: account.Type,
      status: account.Status,
      systemAccount: account.SystemAccount,
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

/**
 * GET https://api.xero.com/api.xro/2.0/TrackingCategories
 *
 * Returns active tracking categories AND their options in one round
 * trip. Used by both:
 *   - The settings picker (admin chooses which category drives our
 *     "projects" list — Xero allows up to 2 active per org).
 *   - The sync flow (we pull options from the chosen category and
 *     upsert them as XeroProject rows).
 *
 * Default behaviour drops archived categories + archived options so
 * the caller doesn't have to filter again. Pass `includeArchived` if
 * you ever need the full set.
 */
export async function getXeroTrackingCategories({
  accessToken,
  tenantId,
  includeArchived = false,
}: {
  accessToken: string
  tenantId: string
  includeArchived?: boolean
}): Promise<XeroTrackingCategory[]> {
  const url = includeArchived
    ? `${XERO_TRACKING_CATEGORIES_URL}?includeArchived=true`
    : XERO_TRACKING_CATEGORIES_URL
  const response = await fetch(url, {
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
      `Xero tracking-categories request failed with ${response.status}: ${JSON.stringify(errorBody)}`,
    )
  }

  const json = (await response.json()) as {
    TrackingCategories?: Array<{
      TrackingCategoryID?: string
      Name?: string
      Status?: string
      Options?: Array<{
        TrackingOptionID?: string
        Name?: string
        Status?: string
        IsArchived?: boolean
      }>
    }>
  }

  const categories = json.TrackingCategories ?? []
  return categories
    .filter((cat) => cat.TrackingCategoryID && cat.Name)
    .filter((cat) => includeArchived || cat.Status === "ACTIVE")
    .map((cat) => ({
      xeroTrackingCategoryId: cat.TrackingCategoryID as string,
      name: cat.Name as string,
      status: cat.Status ?? "ACTIVE",
      options: (cat.Options ?? [])
        .filter((opt) => opt.TrackingOptionID && opt.Name)
        .filter(
          (opt) =>
            includeArchived ||
            (opt.Status === "ACTIVE" && opt.IsArchived !== true),
        )
        .map((opt) => ({
          xeroTrackingOptionId: opt.TrackingOptionID as string,
          name: opt.Name as string,
          status: opt.Status ?? "ACTIVE",
        })),
    }))
}

export async function createXeroBill({
  accessToken,
  tenantId,
  payload,
  idempotencyKey,
  status = "AUTHORISED",
}: {
  accessToken: string
  tenantId: string
  payload: XeroBillPayload
  idempotencyKey: string
  /**
   * Xero bill status on create. `AUTHORISED` = Awaiting Payment
   * (admin's preferred default). `DRAFT` = Draft state (legacy).
   */
  status?: "DRAFT" | "AUTHORISED"
}) {
  const accountCode = payload.accountCode ?? getRequiredEnv("XERO_DEFAULT_ACCOUNT_CODE")

  const lineItem: Record<string, unknown> = {
    Description: payload.description,
    Quantity: 1,
    UnitAmount: payload.amount,
    AccountCode: accountCode,
  }
  // Tracking dimensions (max 2 per line per Xero docs). The new
  // wizard fills exactly one: the project tracking option.
  if (payload.tracking && payload.tracking.length > 0) {
    lineItem.Tracking = payload.tracking.slice(0, 2).map((t) => ({
      Name: t.name,
      Option: t.option,
    }))
  }

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
          Status: status,
          Contact: {
            Name: payload.contactName,
            EmailAddress: payload.contactEmail,
          },
          Date: payload.date,
          DueDate: payload.dueDate,
          CurrencyCode: payload.currency,
          Reference: payload.reference,
          LineAmountTypes: "Exclusive",
          LineItems: [lineItem],
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

/**
 * Create a "Spend Money" bank transaction in Xero (Type: SPEND). Used
 * for COMPANY-money claims — the money already left the chosen bank
 * account, so this records the completed spend (DR expense account,
 * CR bank account) rather than an awaiting-payment bill.
 *
 * Idempotent via the caller-supplied `Idempotency-Key`. Returns the
 * created transaction's ID + number so the caller can persist them and
 * never double-post.
 */
export async function createXeroSpendMoney({
  accessToken,
  tenantId,
  payload,
  idempotencyKey,
}: {
  accessToken: string
  tenantId: string
  payload: XeroSpendMoneyPayload
  idempotencyKey: string
}): Promise<{ bankTransactionId: string; reference?: string }> {
  const lineItem: Record<string, unknown> = {
    Description: payload.description,
    Quantity: 1,
    UnitAmount: payload.amount,
    AccountCode: payload.accountCode,
  }
  if (payload.tracking && payload.tracking.length > 0) {
    lineItem.Tracking = payload.tracking.slice(0, 2).map((t) => ({
      Name: t.name,
      Option: t.option,
    }))
  }

  const response = await fetch(XERO_BANK_TRANSACTIONS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      "xero-tenant-id": tenantId,
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify({
      Type: "SPEND",
      Status: "AUTHORISED",
      Contact: {
        Name: payload.contactName,
        EmailAddress: payload.contactEmail,
      },
      Date: payload.date,
      Reference: payload.reference,
      // The bank/card the money came out of.
      BankAccount: { Code: payload.bankAccountCode },
      LineAmountTypes: "Exclusive",
      LineItems: [lineItem],
    }),
    cache: "no-store",
  })

  if (!response.ok) {
    const errorBody = await parseXeroResponse(response)
    const validationMessages = collectXeroValidationMessages(errorBody)
    const validationSummary = validationMessages.join("; ").slice(0, 150)
    throw new Error(
      validationMessages.length > 0
        ? `Xero spend-money creation failed: ${validationSummary}`
        : `Xero spend-money creation failed with ${response.status}: ${JSON.stringify(errorBody)}`
    )
  }

  const json = (await response.json()) as {
    BankTransactions?: Array<{
      BankTransactionID?: string
      Reference?: string
    }>
    BankTransactionID?: string
    Reference?: string
  }

  const txn = json.BankTransactions?.[0] ?? json
  if (!txn?.BankTransactionID) {
    throw new Error(
      "Xero spend-money creation succeeded but no BankTransactionID was returned."
    )
  }

  return {
    bankTransactionId: txn.BankTransactionID,
    reference: txn.Reference,
  }
}

// ---------------------------------------------------------------------------
// Xero Manual Journals
// ---------------------------------------------------------------------------
//
// Used to post a per-payroll-run summary journal. Single API call
// creates ALL lines on ONE journal (vs Invoices which is one bill
// per call). The line items array carries every debit + credit; Xero
// validates that the sum balances to zero.

export type XeroManualJournalLine = {
  /// Debit lines have a positive LineAmount; credit lines have a
  /// negative LineAmount. Both share the same "AccountCode" field
  /// (account-code-based, not AccountID).
  accountCode: string
  /// Use a positive number for debit, negative for credit. We accept
  /// signed numbers here so the journal-builder service can be
  /// natural about it.
  amount: number
  description: string
  /// Optional tracking dimensions (max 2 per Xero docs). Used for
  /// the project dimension on payroll lines.
  tracking?: Array<{ name: string; option: string }>
}

export type XeroManualJournalPayload = {
  narration: string
  /// YYYY-MM-DD. The journal posts on this date.
  date: string
  lines: XeroManualJournalLine[]
}

/**
 * Post a manual journal to Xero. Status starts as `POSTED` so it
 * lands in the P&L immediately — the admin's "approve payroll" act
 * is the approval signal; no need for a Xero-side review step.
 */
export async function createXeroManualJournal({
  accessToken,
  tenantId,
  payload,
  idempotencyKey,
}: {
  accessToken: string
  tenantId: string
  payload: XeroManualJournalPayload
  idempotencyKey: string
}): Promise<{ manualJournalId: string; narration: string }> {
  const response = await fetch(XERO_MANUAL_JOURNALS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      "xero-tenant-id": tenantId,
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify({
      ManualJournals: [
        {
          Narration: payload.narration,
          Date: payload.date,
          Status: "POSTED",
          LineAmountTypes: "NoTax",
          JournalLines: payload.lines.map((line) => {
            const item: Record<string, unknown> = {
              LineAmount: line.amount,
              AccountCode: line.accountCode,
              Description: line.description,
            }
            if (line.tracking && line.tracking.length > 0) {
              item.Tracking = line.tracking.slice(0, 2).map((t) => ({
                Name: t.name,
                Option: t.option,
              }))
            }
            return item
          }),
        },
      ],
    }),
    cache: "no-store",
  })

  if (!response.ok) {
    const errorBody = await parseXeroResponse(response)
    // Xero returns 401 "AuthorizationUnsuccessful" for manual
    // journals when the connected user lacks the right Xero role
    // (Adviser, or Standard + reports). The same token can post
    // bills fine — manual journals are gated separately. Re-pack
    // this case with a clearer hint so the admin doesn't go on a
    // scope-debugging tangent.
    if (response.status === 401) {
      throw new Error(
        "Xero rejected the manual journal post (401 AuthorizationUnsuccessful). " +
          "Manual journals require the connected Xero user to have the 'Adviser' role " +
          "(or 'Standard + reports') and a Xero plan that supports journals (not Cashbook/Ledger). " +
          "Fix the user's role in Xero → Settings → Users, then disconnect & reconnect this Xero integration.",
      )
    }
    const validationMessages = collectXeroValidationMessages(errorBody)
    throw new Error(
      validationMessages.length > 0
        ? `Xero manual journal creation failed: ${validationMessages.join("; ")}`
        : `Xero manual journal creation failed with ${response.status}: ${JSON.stringify(errorBody)}`,
    )
  }

  const json = (await response.json()) as {
    ManualJournals?: Array<{
      ManualJournalID?: string
      Narration?: string
    }>
  }

  const journal = json.ManualJournals?.[0]
  if (!journal?.ManualJournalID) {
    throw new Error(
      "Xero manual journal creation succeeded but no ManualJournalID was returned.",
    )
  }

  return {
    manualJournalId: journal.ManualJournalID,
    narration: journal.Narration ?? payload.narration,
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

const XERO_LEAVE_ATTACHMENTS_FOLDER_NAME = "Leave Attachments"

/// Look up — or create — the "Leave Attachments" folder in the given
/// Xero tenant. Used to file MC slips and supporting documents
/// uploaded with leave applications.
export async function getOrCreateLeaveAttachmentsFolder(args: {
  accessToken: string
  tenantId: string
}): Promise<string | undefined> {
  return getOrCreateXeroFolder({
    ...args,
    folderName: XERO_LEAVE_ATTACHMENTS_FOLDER_NAME,
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
/**
 * Associate an uploaded Xero file with a Xero object so it shows in that
 * object's Files panel. `objectGroup` selects the target type:
 *   - "Invoice"          → bills + sales invoices (ACCPAY/ACCREC)
 *   - "BankTransaction"  → Spend Money / Receive Money transactions
 * Defaults to "Invoice" to preserve the original bill-attach behaviour.
 */
export async function associateFileWithObject({
  accessToken,
  tenantId,
  fileId,
  objectId,
  objectGroup = "Invoice",
}: {
  accessToken: string
  tenantId: string
  fileId: string
  objectId: string
  objectGroup?: "Invoice" | "BankTransaction"
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
        ObjectId: objectId,
        ObjectGroup: objectGroup,
      }),
    },
  )
  if (!response.ok) {
    const text = await response.text().catch(() => "")
    throw new Error(`Xero file association failed: ${response.status} ${text}`)
  }
}

/**
 * Back-compat shim — existing callers attach receipts to bills. New code
 * should call `associateFileWithObject` directly with the right group.
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
  return associateFileWithObject({
    accessToken,
    tenantId,
    fileId,
    objectId: invoiceId,
    objectGroup: "Invoice",
  })
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
