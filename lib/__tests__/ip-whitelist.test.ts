import { describe, expect, it } from "vitest"

import {
  extractClientIp,
  ipMatchesRawAllowlist,
  parseAllowlist,
} from "../ip-whitelist"

describe("parseAllowlist", () => {
  it("empty / null / undefined → empty array", () => {
    expect(parseAllowlist("")).toEqual([])
    expect(parseAllowlist(null)).toEqual([])
    expect(parseAllowlist(undefined)).toEqual([])
  })

  it("single IP treated as /32", () => {
    const parsed = parseAllowlist("203.106.51.10")
    expect(parsed).toHaveLength(1)
    expect(parsed[0].prefix).toBe(32)
  })

  it("CIDR range parses to (masked network, prefix)", () => {
    const parsed = parseAllowlist("203.106.51.0/24")
    expect(parsed).toHaveLength(1)
    expect(parsed[0].prefix).toBe(24)
  })

  it("mixed comma-separated list", () => {
    const parsed = parseAllowlist("203.106.51.10, 118.100.0.0/16")
    expect(parsed).toHaveLength(2)
    expect(parsed[0].prefix).toBe(32)
    expect(parsed[1].prefix).toBe(16)
  })

  it("silently drops unparseable entries but keeps the good ones", () => {
    const parsed = parseAllowlist("203.106.51.10, garbage, 118.100.0.0/16, /24")
    expect(parsed).toHaveLength(2)
  })

  it("padded octets like 01.02.03.04 rejected", () => {
    expect(parseAllowlist("01.02.03.04")).toEqual([])
  })

  it("prefix outside 0-32 rejected", () => {
    expect(parseAllowlist("10.0.0.0/33")).toEqual([])
    expect(parseAllowlist("10.0.0.0/-1")).toEqual([])
  })
})

describe("ipMatchesRawAllowlist", () => {
  it("single IP exact match", () => {
    expect(ipMatchesRawAllowlist("203.106.51.10", "203.106.51.10")).toBe(true)
  })

  it("single IP mismatch", () => {
    expect(ipMatchesRawAllowlist("203.106.51.11", "203.106.51.10")).toBe(false)
  })

  it("CIDR range /24 matches all 256 addresses in the block", () => {
    const list = "203.106.51.0/24"
    expect(ipMatchesRawAllowlist("203.106.51.0", list)).toBe(true)
    expect(ipMatchesRawAllowlist("203.106.51.128", list)).toBe(true)
    expect(ipMatchesRawAllowlist("203.106.51.255", list)).toBe(true)
    expect(ipMatchesRawAllowlist("203.106.52.0", list)).toBe(false)
  })

  it("CIDR range /16 matches broader subnet", () => {
    expect(ipMatchesRawAllowlist("118.100.5.7", "118.100.0.0/16")).toBe(true)
    expect(ipMatchesRawAllowlist("118.101.5.7", "118.100.0.0/16")).toBe(false)
  })

  it("mixed list — matches any entry", () => {
    const list = "203.106.51.10, 118.100.0.0/16"
    expect(ipMatchesRawAllowlist("203.106.51.10", list)).toBe(true) // single
    expect(ipMatchesRawAllowlist("118.100.99.99", list)).toBe(true) // CIDR
    expect(ipMatchesRawAllowlist("8.8.8.8", list)).toBe(false)
  })

  it("empty allowlist → no match (caller decides feature-off semantics)", () => {
    expect(ipMatchesRawAllowlist("203.106.51.10", "")).toBe(false)
    expect(ipMatchesRawAllowlist("203.106.51.10", null)).toBe(false)
  })

  it("non-canonical typed CIDR still matches — admin can type `.42/24`", () => {
    // Admin typed a host address with a mask; the parser normalises
    // to the network address so lookups still work.
    expect(ipMatchesRawAllowlist("203.106.51.99", "203.106.51.42/24")).toBe(
      true,
    )
  })

  it("prefix /0 → matches everything (defensive; admin shouldn't type this)", () => {
    expect(ipMatchesRawAllowlist("8.8.8.8", "0.0.0.0/0")).toBe(true)
  })

  it("malformed IP → no match, doesn't throw", () => {
    expect(() => ipMatchesRawAllowlist("not-an-ip", "203.106.51.0/24")).not.toThrow()
    expect(ipMatchesRawAllowlist("not-an-ip", "203.106.51.0/24")).toBe(false)
  })
})

describe("extractClientIp", () => {
  it("prefers x-forwarded-for over x-real-ip", () => {
    const h = new Headers()
    h.set("x-forwarded-for", "203.106.51.10")
    h.set("x-real-ip", "10.0.0.1")
    expect(extractClientIp(h)).toBe("203.106.51.10")
  })

  it("takes the leftmost value from x-forwarded-for chain", () => {
    const h = new Headers({
      "x-forwarded-for": "203.106.51.10, 10.0.0.1, 172.16.0.1",
    })
    expect(extractClientIp(h)).toBe("203.106.51.10")
  })

  it("falls back to x-real-ip when x-forwarded-for absent", () => {
    const h = new Headers({ "x-real-ip": "10.0.0.5" })
    expect(extractClientIp(h)).toBe("10.0.0.5")
  })

  it("returns null when neither header present", () => {
    expect(extractClientIp(new Headers())).toBeNull()
  })

  it("trims whitespace", () => {
    const h = new Headers({ "x-forwarded-for": "  203.106.51.10  " })
    expect(extractClientIp(h)).toBe("203.106.51.10")
  })
})
