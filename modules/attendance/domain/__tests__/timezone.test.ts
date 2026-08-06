import { describe, expect, it } from "vitest"

import {
  DEFAULT_TIMEZONE,
  expectedTimeOnLocalDay,
  formatLocalHm,
  isValidTimezone,
  startOfLocalDay,
} from "@/modules/attendance/domain/timezone"

const KL = "Asia/Kuala_Lumpur"

/** The day-key convention: UTC-midnight of a local calendar date. */
function dayKey(d: Date): string {
  return d.toISOString()
}

describe("startOfLocalDay", () => {
  /**
   * REGRESSION GUARD — this is the bug fixed in bdcdfc5.
   *
   * Before the fix, clock-in derived the day-key with
   * `new Date().setUTCHours(0,0,0,0)`. Malaysia is UTC+8, so every
   * clock-in between 00:00 and 08:00 MYT is still the PREVIOUS day in
   * UTC and got filed one day early. 23 production sessions were
   * mis-filed this way before it was caught — mostly the 07:00–08:00
   * MYT arrivals, i.e. the single most common start of the workday.
   *
   * If anyone reintroduces UTC-midnight truncation here, this fails.
   */
  it("files an early-morning MYT clock-in under the local day, not the UTC day", () => {
    // 2026-08-04 07:26 MYT === 2026-08-03 23:26 UTC
    const clockIn = new Date("2026-08-03T23:26:22.755Z")

    expect(dayKey(startOfLocalDay(clockIn, KL))).toBe("2026-08-04T00:00:00.000Z")

    // Explicitly assert we did NOT get the naive UTC truncation.
    const naive = new Date(clockIn)
    naive.setUTCHours(0, 0, 0, 0)
    expect(dayKey(startOfLocalDay(clockIn, KL))).not.toBe(dayKey(naive))
  })

  it("holds across the whole 00:00-08:00 MYT window that used to break", () => {
    // Every one of these is "the previous day" in UTC.
    const cases = [
      "2026-08-03T16:00:00.000Z", // 2026-08-04 00:00 MYT — the boundary itself
      "2026-08-03T18:08:36.670Z", // 02:08 MYT
      "2026-08-03T22:43:22.693Z", // 06:43 MYT
      "2026-08-03T23:59:59.999Z", // 07:59 MYT
    ]
    for (const iso of cases) {
      expect(dayKey(startOfLocalDay(new Date(iso), KL))).toBe(
        "2026-08-04T00:00:00.000Z",
      )
    }
  })

  it("does not roll over early: 23:59 MYT still belongs to that same day", () => {
    // 2026-08-04 23:59 MYT === 2026-08-04 15:59 UTC
    expect(dayKey(startOfLocalDay(new Date("2026-08-04T15:59:00.000Z"), KL))).toBe(
      "2026-08-04T00:00:00.000Z",
    )
    // One minute later is the next local day.
    expect(dayKey(startOfLocalDay(new Date("2026-08-04T16:00:00.000Z"), KL))).toBe(
      "2026-08-05T00:00:00.000Z",
    )
  })

  it("is independent of the process timezone", () => {
    // The droplet currently runs Asia/Kuala_Lumpur, but nothing pins it —
    // the day-key must not silently change if the box is rebuilt as UTC.
    // Intl with an explicit timeZone gives us that; a getHours()-based
    // implementation would not.
    const at = new Date("2026-08-03T23:26:22.755Z")
    const before = process.env.TZ
    try {
      process.env.TZ = "UTC"
      const asUtcBox = dayKey(startOfLocalDay(at, KL))
      process.env.TZ = "America/Los_Angeles"
      const asLaBox = dayKey(startOfLocalDay(at, KL))
      expect(asUtcBox).toBe("2026-08-04T00:00:00.000Z")
      expect(asLaBox).toBe(asUtcBox)
    } finally {
      process.env.TZ = before
    }
  })

  it("handles timezones west of UTC (org on a negative offset)", () => {
    // 2026-08-04 20:00 New York === 2026-08-05 00:00 UTC.
    // The local day is still the 4th even though UTC has ticked over.
    expect(
      dayKey(startOfLocalDay(new Date("2026-08-05T00:00:00.000Z"), "America/New_York")),
    ).toBe("2026-08-04T00:00:00.000Z")
  })

  it("treats UTC orgs as a plain UTC day", () => {
    expect(dayKey(startOfLocalDay(new Date("2026-08-03T23:26:00.000Z"), "UTC"))).toBe(
      "2026-08-03T00:00:00.000Z",
    )
  })

  it("returns exact UTC midnight so it matches the employeeId_date unique key", () => {
    // AttendanceRecord.date is looked up by equality, so any stray
    // time-of-day component would silently miss today's row.
    const key = startOfLocalDay(new Date("2026-08-03T23:26:22.755Z"), KL)
    expect(key.getUTCHours()).toBe(0)
    expect(key.getUTCMinutes()).toBe(0)
    expect(key.getUTCSeconds()).toBe(0)
    expect(key.getUTCMilliseconds()).toBe(0)
  })

  it("is idempotent — re-keying an existing day-key is a no-op", () => {
    // Read paths re-normalize stored day-keys; that must not shift them.
    const key = startOfLocalDay(new Date("2026-08-03T23:26:22.755Z"), KL)
    expect(dayKey(startOfLocalDay(key, KL))).toBe(dayKey(key))
  })
})

describe("expectedTimeOnLocalDay", () => {
  it("anchors the expected start to the local day, so early arrivals read as early", () => {
    // 07:26 MYT arrival vs an 09:00 local start — expected start must be
    // 09:00 MYT on 2026-08-04 (= 01:00 UTC), i.e. AFTER the clock-in.
    const clockIn = new Date("2026-08-03T23:26:22.755Z")
    const expected = expectedTimeOnLocalDay(clockIn, "09:00", KL)

    expect(expected.toISOString()).toBe("2026-08-04T01:00:00.000Z")
    expect(expected.getTime()).toBeGreaterThan(clockIn.getTime())
  })

  it("marks a genuinely late arrival as late", () => {
    // 09:30 MYT === 01:30 UTC, against an 09:00 local start.
    const clockIn = new Date("2026-08-04T01:30:00.000Z")
    const expected = expectedTimeOnLocalDay(clockIn, "09:00", KL)
    expect(clockIn.getTime()).toBeGreaterThan(expected.getTime())
    expect((clockIn.getTime() - expected.getTime()) / 60000).toBe(30)
  })

  it("falls back to 09:00 on an unparseable time", () => {
    const at = new Date("2026-08-04T01:00:00.000Z")
    expect(expectedTimeOnLocalDay(at, "not-a-time", KL).toISOString()).toBe(
      "2026-08-04T01:00:00.000Z",
    )
  })
})

describe("formatLocalHm", () => {
  it("renders the org-local wall clock, not UTC", () => {
    expect(formatLocalHm(new Date("2026-08-03T23:26:00.000Z"), KL)).toBe("07:26")
  })

  it("uses 24-hour form without a midnight 24:00 artifact", () => {
    expect(formatLocalHm(new Date("2026-08-03T16:00:00.000Z"), KL)).toBe("00:00")
  })
})

describe("timezone configuration", () => {
  it("defaults to Malaysia", () => {
    expect(DEFAULT_TIMEZONE).toBe(KL)
  })

  it("accepts real IANA zones and rejects junk", () => {
    expect(isValidTimezone(KL)).toBe(true)
    expect(isValidTimezone("UTC")).toBe(true)
    expect(isValidTimezone("Mars/Olympus_Mons")).toBe(false)
    expect(isValidTimezone("")).toBe(false)
  })
})
