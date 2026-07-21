export const DEFAULT_GEOFENCE_RADIUS_METERS = 200

export function haversineMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const R = 6371000
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}

export type GeofenceCheck = {
  withinRadius: boolean
  distanceMeters: number | null
  reason: "ok" | "no_gps" | "no_project_coords" | "outside_radius"
}

export function checkGeofence(
  employee: { lat: number; lng: number } | null,
  project: { latitude: number | null; longitude: number | null },
  radiusMeters: number,
): GeofenceCheck {
  if (!employee) {
    return { withinRadius: false, distanceMeters: null, reason: "no_gps" }
  }
  if (project.latitude == null || project.longitude == null) {
    return { withinRadius: false, distanceMeters: null, reason: "no_project_coords" }
  }
  const distance = haversineMeters(
    employee.lat,
    employee.lng,
    project.latitude,
    project.longitude,
  )
  if (distance <= radiusMeters) {
    return { withinRadius: true, distanceMeters: distance, reason: "ok" }
  }
  return { withinRadius: false, distanceMeters: distance, reason: "outside_radius" }
}

/**
 * Human-readable distance label. Meters when small enough to be
 * meaningful, km when the number would otherwise be a wall of digits.
 * Threshold is 1000m — "28409m" reads as a phone number; "28.41 km"
 * reads as a distance. Rounds to a whole meter under 1km and two
 * decimals above.
 */
export function formatDistance(meters: number): string {
  if (meters < 1000) return `${Math.round(meters)}m`
  return `${(meters / 1000).toFixed(2)} km`
}

/// Result of a multi-site geofence check. `ok: true` means one of the
/// `locations` was within `radiusMeters`; `matchedIndex` / `matchedLabel`
/// identify which. `ok: false` returns the `nearest` site (if any) so the
/// UI can auto-populate an off-site remark like "500m from HQ".
export type GeofenceMultiResult =
  | { ok: true; matchedIndex: number; matchedLabel: string; distanceMeters: number }
  | { ok: false; nearest: { label: string; distanceMeters: number } | null }

/// Walk `locations` in the given order — the first site within
/// `radiusMeters` wins. Deterministic tie-breaking on order matches the
/// admin's expressed preference in the UI ("Detection walks these in
/// order at clock-in — first one within the geofence radius wins"). If
/// none match, returns the nearest site's label + distance so callers
/// can surface it.
///
/// Empty `locations` → `{ ok: false, nearest: null }`. The caller is
/// expected to then fall back to the legacy single-lat/lng
/// `checkGeofence` path for projects that haven't been backfilled.
export function checkGeofenceMulti(
  coords: { latitude: number; longitude: number } | null,
  locations: Array<{ label: string; latitude: number; longitude: number }>,
  radiusMeters: number,
): GeofenceMultiResult {
  if (!coords) return { ok: false, nearest: null }
  if (locations.length === 0) return { ok: false, nearest: null }

  let nearest: { label: string; distanceMeters: number } | null = null
  for (let i = 0; i < locations.length; i += 1) {
    const loc = locations[i]!
    const distance = haversineMeters(
      coords.latitude,
      coords.longitude,
      loc.latitude,
      loc.longitude,
    )
    if (distance <= radiusMeters) {
      return {
        ok: true,
        matchedIndex: i,
        matchedLabel: loc.label,
        distanceMeters: distance,
      }
    }
    if (nearest === null || distance < nearest.distanceMeters) {
      nearest = { label: loc.label, distanceMeters: distance }
    }
  }
  return { ok: false, nearest }
}
