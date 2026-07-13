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
