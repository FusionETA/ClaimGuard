import "server-only"

import { hashPassword } from "@/lib/auth/password"
import { getPrismaClient } from "@/lib/prisma"
import type {
  ChartOfAccountOption,
  OrganizationMember,
  OrganizationProjectOption,
  OrganizationSummary,
  XeroConnectionInfo,
  XeroConnectionSummary,
} from "@/modules/organization/domain/models"

export type XeroConnectionRecord = {
  id: string
  organizationId: string
  tenantId: string
  tenantName: string
  tenantType: string | null
  accessToken: string
  refreshToken: string
  scope: string
  tokenType: string
  accessTokenExpiresAt: Date
  createdAt: Date
  updatedAt: Date
}

function mapOrganizationSummary(
  org?: { id: string; name: string; claimCutoffDay: number } | null
): OrganizationSummary | undefined {
  if (!org) return undefined

  return {
    id: org.id,
    name: org.name,
    claimCutoffDay: org.claimCutoffDay,
  }
}

function mapChartAccount(account?: {
  id: string
  code: string
  name: string
  type: string | null
  status: string | null
  isSelectable: boolean
  isCustom: boolean
  xeroConnectionId: string | null
} | null): ChartOfAccountOption | undefined {
  if (!account) return undefined

  return {
    id: account.id,
    code: account.code,
    name: account.name,
    type: account.type ?? undefined,
    status: account.status ?? undefined,
    isSelectable: account.isSelectable,
    isCustom: account.isCustom,
    xeroConnectionId: account.xeroConnectionId ?? undefined,
  }
}

export const organizationRepository = {
  async getOrganizationById(organizationId: string): Promise<OrganizationSummary | null> {
    const prisma = getPrismaClient()
    if (!prisma) return null

    const row = await prisma.organization.findUnique({
      where: { id: organizationId },
    })

    return mapOrganizationSummary(row) ?? null
  },

  async upsertAdminOrganization(data: {
    adminUserId: string
    organizationName: string
  }): Promise<OrganizationSummary> {
    const prisma = getPrismaClient()
    if (!prisma) {
      throw new Error("Database is not configured.")
    }

    const organizationName = data.organizationName.trim()
    const admin = await prisma.user.findUnique({
      where: { id: data.adminUserId },
      select: { organizationId: true, role: true },
    })

    if (!admin || admin.role !== "ADMIN") {
      throw new Error("Admin account not found.")
    }

    if (admin.organizationId) {
      const existingWithName = await prisma.organization.findUnique({
        where: { name: organizationName },
        select: { id: true },
      })

      if (existingWithName && existingWithName.id !== admin.organizationId) {
        throw new Error("That organization name is already being used by another organization.")
      }

      const organization = await prisma.organization.update({
        where: { id: admin.organizationId },
        data: { name: organizationName },
      })

      return {
        id: organization.id,
        name: organization.name,
        claimCutoffDay: organization.claimCutoffDay,
      }
    }

    const existing = await prisma.organization.findUnique({
      where: { name: organizationName },
      select: { id: true },
    })

    if (existing) {
      throw new Error("That organization name is already being used by another organization.")
    }

    const organization = await prisma.organization.create({
      data: {
        name: organizationName,
      },
    })

    await prisma.user.update({
      where: { id: data.adminUserId },
      data: { organizationId: organization.id },
    })

    return {
      id: organization.id,
      name: organization.name,
      claimCutoffDay: organization.claimCutoffDay,
    }
  },

  async updateOrganizationClaimCutoff(data: {
    organizationId: string
    claimCutoffDay: number
  }): Promise<void> {
    const prisma = getPrismaClient()
    if (!prisma) {
      throw new Error("Database is not configured.")
    }

    await prisma.organization.update({
      where: { id: data.organizationId },
      data: { claimCutoffDay: data.claimCutoffDay },
    })
  },

  async getOrganizationMembers(
    organizationId: string,
    xeroConnectionId?: string
  ): Promise<OrganizationMember[]> {
    const prisma = getPrismaClient()
    if (!prisma) return []

    const rows = await prisma.user.findMany({
      where: {
        organizationId,
        role: { in: ["EMPLOYEE", "SUPERVISOR"] },
        ...(xeroConnectionId
          ? { employeeProfile: { xeroConnectionId } }
          : {}),
      },
      include: {
        organization: true,
        employeeProfile: {
          include: {
            supervisor: true,
            xeroConnection: { select: { id: true, tenantName: true } },
          },
        },
      },
      orderBy: { name: "asc" },
    })

    return rows.map((user) => ({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role as OrganizationMember["role"],
      organizationId: user.organizationId ?? undefined,
      organizationName: user.organization?.name ?? undefined,
      employeeId: user.employeeProfile?.employeeId ?? "N/A",
      project: user.employeeProfile?.project ?? "Unknown",
      jobTitle: user.employeeProfile?.jobTitle ?? "Employee",
      supervisorId: user.employeeProfile?.supervisorId ?? undefined,
      supervisorName: user.employeeProfile?.supervisor?.name ?? undefined,
      xeroConnectionId: user.employeeProfile?.xeroConnectionId ?? undefined,
      xeroConnectionName: user.employeeProfile?.xeroConnection?.tenantName ?? undefined,
    }))
  },

  async updateOrganizationMember(data: {
    userId: string
    role: "EMPLOYEE" | "SUPERVISOR"
    organizationId: string
    project?: string
    jobTitle: string
    supervisorId?: string
    xeroConnectionId?: string
  }): Promise<boolean> {
    const prisma = getPrismaClient()
    if (!prisma) return false

    const targetUser = await prisma.user.findUnique({
      where: { id: data.userId },
      select: { organizationId: true, role: true },
    })

    if (
      !targetUser ||
      targetUser.role === "ADMIN" ||
      targetUser.organizationId !== data.organizationId
    ) {
      throw new Error("You can only manage members inside your own organization.")
    }

    if (data.supervisorId) {
      const supervisor = await prisma.user.findUnique({
        where: { id: data.supervisorId },
        select: { organizationId: true, role: true },
      })

      if (
        !supervisor ||
        supervisor.organizationId !== data.organizationId ||
        supervisor.role !== "SUPERVISOR"
      ) {
        throw new Error("Supervisor must belong to your organization.")
      }
    }

    await prisma.$transaction([
      prisma.user.update({
        where: { id: data.userId },
        data: {
          role: data.role,
          organizationId: data.organizationId,
        },
      }),
      prisma.employeeProfile.update({
        where: { userId: data.userId },
        data: {
          project: data.project ?? "",
          jobTitle: data.jobTitle,
          supervisorId: data.supervisorId || null,
          xeroConnectionId: data.xeroConnectionId || null,
        },
      }),
    ])

    return true
  },

  async createOrganizationMember(data: {
    name: string
    email: string
    password: string
    employeeId: string
    role: "EMPLOYEE" | "SUPERVISOR"
    organizationId: string
    project?: string
    jobTitle: string
    supervisorId?: string
    xeroConnectionId?: string
  }): Promise<boolean> {
    const prisma = getPrismaClient()
    if (!prisma) return false

    const existingUser = await prisma.user.findUnique({
      where: { email: data.email },
      select: { id: true },
    })

    if (existingUser) {
      throw new Error("That email is already being used by another account.")
    }

    const existingEmployeeProfile = await prisma.employeeProfile.findUnique({
      where: { employeeId: data.employeeId },
      select: { id: true },
    })

    if (existingEmployeeProfile) {
      throw new Error("That employee ID is already assigned to another user.")
    }

    if (data.supervisorId) {
      const supervisor = await prisma.user.findUnique({
        where: { id: data.supervisorId },
        select: { organizationId: true, role: true },
      })

      if (
        !supervisor ||
        supervisor.organizationId !== data.organizationId ||
        supervisor.role !== "SUPERVISOR"
      ) {
        throw new Error("Supervisor must belong to your organization.")
      }
    }

    await prisma.user.create({
      data: {
        name: data.name,
        email: data.email,
        passwordHash: hashPassword(data.password),
        role: data.role,
        organizationId: data.organizationId,
        employeeProfile: {
          create: {
            employeeId: data.employeeId,
            project: data.project ?? "",
            jobTitle: data.jobTitle,
            supervisorId: data.supervisorId || null,
            preferredCurrency: "USD",
            xeroConnectionId: data.xeroConnectionId || null,
          },
        },
      },
    })

    return true
  },

  // ---------------------------------------------------------------------------
  // XeroConnection queries
  // ---------------------------------------------------------------------------

  async getXeroConnections(organizationId: string): Promise<XeroConnectionInfo[]> {
    const prisma = getPrismaClient()
    if (!prisma) return []

    const rows = await prisma.xeroConnection.findMany({
      where: { organizationId },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        tenantId: true,
        tenantName: true,
        tenantType: true,
        createdAt: true,
        updatedAt: true,
      },
    })

    return rows.map((row) => ({
      id: row.id,
      tenantId: row.tenantId,
      tenantName: row.tenantName,
      tenantType: row.tenantType ?? undefined,
      connectedAt: row.createdAt.toISOString(),
      lastTokenRefreshAt: row.updatedAt.toISOString(),
    }))
  },

  async getXeroConnectionById(connectionId: string): Promise<XeroConnectionRecord | null> {
    const prisma = getPrismaClient()
    if (!prisma) return null

    return prisma.xeroConnection.findUnique({
      where: { id: connectionId },
    })
  },

  async getXeroConnectionSummary(organizationId: string): Promise<XeroConnectionSummary | null> {
    const prisma = getPrismaClient()
    if (!prisma) return null

    const rows = await prisma.xeroConnection.findMany({
      where: { organizationId },
      select: {
        id: true,
        tenantId: true,
        tenantName: true,
        tenantType: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { createdAt: "asc" },
    })

    return {
      configured: true,
      missingConfig: [],
      connections: rows.map((row) => ({
        id: row.id,
        tenantId: row.tenantId,
        tenantName: row.tenantName,
        tenantType: row.tenantType ?? undefined,
        connectedAt: row.createdAt.toISOString(),
        lastTokenRefreshAt: row.updatedAt.toISOString(),
      })),
    }
  },

  async upsertXeroConnection(data: {
    organizationId: string
    tenantId: string
    tenantName: string
    tenantType?: string
    accessToken: string
    refreshToken: string
    scope: string
    tokenType: string
    accessTokenExpiresAt: Date
    connectedByAdminId: string
  }): Promise<void> {
    const prisma = getPrismaClient()
    if (!prisma) {
      throw new Error("Database is not configured.")
    }

    await prisma.xeroConnection.upsert({
      where: {
        organizationId_tenantId: {
          organizationId: data.organizationId,
          tenantId: data.tenantId,
        },
      },
      create: {
        provider: "xero",
        organizationId: data.organizationId,
        tenantId: data.tenantId,
        tenantName: data.tenantName,
        tenantType: data.tenantType,
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
        scope: data.scope,
        tokenType: data.tokenType,
        accessTokenExpiresAt: data.accessTokenExpiresAt,
        connectedByAdminId: data.connectedByAdminId,
      },
      update: {
        tenantName: data.tenantName,
        tenantType: data.tenantType,
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
        scope: data.scope,
        tokenType: data.tokenType,
        accessTokenExpiresAt: data.accessTokenExpiresAt,
        connectedByAdminId: data.connectedByAdminId,
      },
    })
  },

  /**
   * Updates tokens only if the refresh token in the DB still matches `oldRefreshToken`.
   * Uses connectionId (the connection's own primary key) as the where key.
   * Returns true if the update was applied.
   */
  async updateXeroConnectionTokensIfMatch(data: {
    connectionId: string
    oldRefreshToken: string
    accessToken: string
    refreshToken: string
    scope: string
    tokenType: string
    accessTokenExpiresAt: Date
  }): Promise<boolean> {
    const prisma = getPrismaClient()
    if (!prisma) {
      throw new Error("Database is not configured.")
    }

    const result = await prisma.xeroConnection.updateMany({
      where: {
        id: data.connectionId,
        refreshToken: data.oldRefreshToken,
      },
      data: {
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
        scope: data.scope,
        tokenType: data.tokenType,
        accessTokenExpiresAt: data.accessTokenExpiresAt,
      },
    })

    return result.count > 0
  },

  // ---------------------------------------------------------------------------
  // Chart of Accounts
  // ---------------------------------------------------------------------------

  async getChartAccountsForConnection(xeroConnectionId: string): Promise<ChartOfAccountOption[]> {
    const prisma = getPrismaClient()
    if (!prisma) return []

    const rows = await prisma.chartOfAccount.findMany({
      where: { xeroConnectionId },
      orderBy: [{ code: "asc" }, { name: "asc" }],
    })

    return rows.map((row) => mapChartAccount(row)!)
  },

  async getSelectableChartAccountsForEmployee(data: {
    organizationId: string
    xeroConnectionId?: string
  }): Promise<ChartOfAccountOption[]> {
    const prisma = getPrismaClient()
    if (!prisma) return []

    if (data.xeroConnectionId) {
      // Employee assigned to a Xero connection — return selectable accounts for that connection
      const rows = await prisma.chartOfAccount.findMany({
        where: {
          xeroConnectionId: data.xeroConnectionId,
          isSelectable: true,
        },
        orderBy: [{ code: "asc" }, { name: "asc" }],
      })
      return rows.map((row) => mapChartAccount(row)!)
    }

    // No Xero connection — return custom accounts (xeroConnectionId IS null) that are selectable
    const rows = await prisma.chartOfAccount.findMany({
      where: {
        organizationId: data.organizationId,
        xeroConnectionId: null,
        isSelectable: true,
      },
      orderBy: [{ code: "asc" }, { name: "asc" }],
    })

    return rows.map((row) => mapChartAccount(row)!)
  },

  async getSelectableChartAccountsForOrganization(
    organizationId: string
  ): Promise<ChartOfAccountOption[]> {
    const prisma = getPrismaClient()
    if (!prisma) return []

    const rows = await prisma.chartOfAccount.findMany({
      where: {
        organizationId,
        isSelectable: true,
      },
      orderBy: [{ code: "asc" }, { name: "asc" }],
    })

    return rows.map((row) => mapChartAccount(row)!)
  },

  async getChartAccountsForOrganization(organizationId: string): Promise<ChartOfAccountOption[]> {
    const prisma = getPrismaClient()
    if (!prisma) return []

    const rows = await prisma.chartOfAccount.findMany({
      where: { organizationId },
      orderBy: [{ code: "asc" }, { name: "asc" }],
    })

    return rows.map((row) => mapChartAccount(row)!)
  },

  async getCustomChartAccountsForOrganization(
    organizationId: string
  ): Promise<ChartOfAccountOption[]> {
    const prisma = getPrismaClient()
    if (!prisma) return []

    const rows = await prisma.chartOfAccount.findMany({
      where: { organizationId, xeroConnectionId: null },
      orderBy: [{ code: "asc" }, { name: "asc" }],
    })

    return rows.map((row) => mapChartAccount(row)!)
  },

  async getChartAccountByIdForOrganization(data: {
    organizationId: string
    chartOfAccountId: string
  }): Promise<ChartOfAccountOption | null> {
    const prisma = getPrismaClient()
    if (!prisma) return null

    const row = await prisma.chartOfAccount.findFirst({
      where: {
        id: data.chartOfAccountId,
        organizationId: data.organizationId,
        isSelectable: true,
      },
    })

    return mapChartAccount(row) ?? null
  },

  async createCustomChartAccount(data: {
    organizationId: string
    code: string
    name: string
    type?: string
    isSelectable: boolean
  }): Promise<ChartOfAccountOption> {
    const prisma = getPrismaClient()
    if (!prisma) {
      throw new Error("Database is not configured.")
    }

    const row = await prisma.chartOfAccount.create({
      data: {
        organizationId: data.organizationId,
        xeroConnectionId: null,
        xeroAccountId: null,
        code: data.code,
        name: data.name,
        type: data.type,
        isSelectable: data.isSelectable,
        isCustom: true,
      },
    })

    return mapChartAccount(row)!
  },

  async updateCustomChartAccount(data: {
    id: string
    organizationId: string
    code: string
    name: string
    type?: string
    isSelectable: boolean
  }): Promise<void> {
    const prisma = getPrismaClient()
    if (!prisma) {
      throw new Error("Database is not configured.")
    }

    await prisma.chartOfAccount.updateMany({
      where: { id: data.id, organizationId: data.organizationId, isCustom: true },
      data: {
        code: data.code,
        name: data.name,
        type: data.type,
        isSelectable: data.isSelectable,
      },
    })
  },

  async deleteCustomChartAccount(data: {
    id: string
    organizationId: string
  }): Promise<void> {
    const prisma = getPrismaClient()
    if (!prisma) {
      throw new Error("Database is not configured.")
    }

    await prisma.chartOfAccount.deleteMany({
      where: { id: data.id, organizationId: data.organizationId, isCustom: true },
    })
  },

  async upsertChartAccountsFromXero(data: {
    xeroConnectionId: string
    organizationId: string
    accounts: Array<{
      xeroAccountId: string
      code: string
      name: string
      type?: string
      status?: string
    }>
  }): Promise<void> {
    const prisma = getPrismaClient()
    if (!prisma) {
      throw new Error("Database is not configured.")
    }

    const incomingIds = data.accounts.map((account) => account.xeroAccountId)

    await prisma.$transaction([
      prisma.chartOfAccount.deleteMany({
        where: {
          xeroConnectionId: data.xeroConnectionId,
          ...(incomingIds.length > 0
            ? { xeroAccountId: { notIn: incomingIds } }
            : {}),
        },
      }),
      ...data.accounts.map((account) =>
        prisma.chartOfAccount.upsert({
          where: {
            xeroConnectionId_xeroAccountId: {
              xeroConnectionId: data.xeroConnectionId,
              xeroAccountId: account.xeroAccountId,
            },
          },
          create: {
            organizationId: data.organizationId,
            xeroConnectionId: data.xeroConnectionId,
            xeroAccountId: account.xeroAccountId,
            code: account.code,
            name: account.name,
            type: account.type,
            status: account.status,
            isCustom: false,
          },
          update: {
            code: account.code,
            name: account.name,
            type: account.type,
            status: account.status,
          },
        })
      ),
    ])
  },

  async setSelectableChartAccounts(data: {
    organizationId: string
    xeroConnectionId?: string
    chartAccountIds: string[]
  }): Promise<void> {
    const prisma = getPrismaClient()
    if (!prisma) {
      throw new Error("Database is not configured.")
    }

    const scopeWhere = data.xeroConnectionId
      ? { organizationId: data.organizationId, xeroConnectionId: data.xeroConnectionId }
      : { organizationId: data.organizationId, xeroConnectionId: null }

    await prisma.$transaction([
      prisma.chartOfAccount.updateMany({
        where: scopeWhere,
        data: { isSelectable: false },
      }),
      ...(data.chartAccountIds.length > 0
        ? [
            prisma.chartOfAccount.updateMany({
              where: {
                ...scopeWhere,
                id: { in: data.chartAccountIds },
              },
              data: { isSelectable: true },
            }),
          ]
        : []),
    ])
  },

  // ---------------------------------------------------------------------------
  // Projects
  // ---------------------------------------------------------------------------

  async getProjectsForConnection(xeroConnectionId: string): Promise<OrganizationProjectOption[]> {
    const prisma = getPrismaClient()
    if (!prisma) return []

    const rows = await prisma.xeroProject.findMany({
      where: { xeroConnectionId },
      orderBy: [{ name: "asc" }],
    })

    return rows.map((row) => ({
      id: row.id,
      xeroProjectId: row.xeroProjectId,
      name: row.name,
      status: row.status ?? undefined,
      contactId: row.contactId ?? undefined,
      xeroConnectionId: row.xeroConnectionId,
    }))
  },

  async getProjectsForOrganization(organizationId: string): Promise<OrganizationProjectOption[]> {
    const prisma = getPrismaClient()
    if (!prisma) return []

    const rows = await prisma.xeroProject.findMany({
      where: { organizationId },
      orderBy: [{ name: "asc" }],
    })

    return rows.map((row) => ({
      id: row.id,
      xeroProjectId: row.xeroProjectId,
      name: row.name,
      status: row.status ?? undefined,
      contactId: row.contactId ?? undefined,
      xeroConnectionId: row.xeroConnectionId,
    }))
  },

  async upsertProjectsFromXero(data: {
    xeroConnectionId: string
    organizationId: string
    projects: Array<{
      xeroProjectId: string
      name: string
      status?: string
      contactId?: string
    }>
  }): Promise<void> {
    const prisma = getPrismaClient()
    if (!prisma) {
      throw new Error("Database is not configured.")
    }

    await Promise.all(
      data.projects.map((project) =>
        prisma.xeroProject.upsert({
          where: {
            xeroConnectionId_xeroProjectId: {
              xeroConnectionId: data.xeroConnectionId,
              xeroProjectId: project.xeroProjectId,
            },
          },
          create: {
            organizationId: data.organizationId,
            xeroConnectionId: data.xeroConnectionId,
            xeroProjectId: project.xeroProjectId,
            name: project.name,
            status: project.status,
            contactId: project.contactId,
          },
          update: {
            name: project.name,
            status: project.status,
            contactId: project.contactId,
          },
        })
      )
    )
  },

  // ---------------------------------------------------------------------------
  // Tenant management
  // ---------------------------------------------------------------------------

  /**
   * Returns the subset of the given tenantIds that are already connected to a
   * *different* organisation. Used to prevent two orgs sharing the same Xero tenant.
   */
  async getInUseTenantIds(
    tenantIds: string[],
    excludeOrganizationId: string
  ): Promise<string[]> {
    const prisma = getPrismaClient()
    if (!prisma || tenantIds.length === 0) return []

    const rows = await prisma.xeroConnection.findMany({
      where: {
        tenantId: { in: tenantIds },
        organizationId: { not: excludeOrganizationId },
      },
      select: { tenantId: true },
    })

    return rows.map((r) => r.tenantId)
  },
}
