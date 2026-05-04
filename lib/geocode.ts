/**
 * Geocoding helper — turns an address string into latitude/longitude.
 *
 * Backed by Geoapify's Geocoding "search" endpoint (single-result lookup).
 * Called from server actions when an address is entered without explicit
 * coordinates, so we can store both the human-readable address AND the
 * coords needed for distance / map features.
 *
 * Returns null on any failure (missing API key, no matches, network error,
 * malformed response). Callers should treat null as "we couldn't resolve
 * coords" rather than a hard error — the address text is still saved.
 */

const GEOAPIFY_KEY = process.env.NEXT_PUBLIC_GEOAPIFY_API_KEY
const SEARCH_ENDPOINT = "https://api.geoapify.com/v1/geocode/search"

export type GeocodeResult = {
  lat: number
  lng: number
  /** The canonicalised address Geoapify returned, if available. */
  formatted?: string
}

export async function geocodeAddress(text: string): Promise<GeocodeResult | null> {
  if (!GEOAPIFY_KEY) return null
  const trimmed = text.trim()
  if (!trimmed) return null

  // If the text is already "lat, lng" coordinates, just parse it — no need
  // to spend an API call on something we can read directly.
  const coordMatch = trimmed.match(
    /^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/
  )
  if (coordMatch) {
    const lat = Number(coordMatch[1])
    const lng = Number(coordMatch[2])
    if (
      Number.isFinite(lat) &&
      Number.isFinite(lng) &&
      lat >= -90 &&
      lat <= 90 &&
      lng >= -180 &&
      lng <= 180
    ) {
      return { lat, lng }
    }
  }

  try {
    const params = new URLSearchParams({
      text: trimmed,
      apiKey: GEOAPIFY_KEY,
      format: "json",
      limit: "1",
      lang: "en",
    })
    const res = await fetch(`${SEARCH_ENDPOINT}?${params}`)
    if (!res.ok) return null
    const data = (await res.json()) as {
      results?: Array<{ lat?: number; lon?: number; formatted?: string }>
    }
    const first = data.results?.[0]
    if (!first || typeof first.lat !== "number" || typeof first.lon !== "number") {
      return null
    }
    return { lat: first.lat, lng: first.lon, formatted: first.formatted }
  } catch {
    return null
  }
}
