/**
 * Haversine great-circle distance between two WGS-84 coordinates.
 *
 * Returns the distance in kilometres.  The formula gives the shortest
 * over-surface distance and is accurate to ~0.3 % for the scales used
 * here (city / municipality level, up to ~50 km).
 */
export function haversineKm(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const R = 6_371; // mean Earth radius, km
  const toRad = (deg: number) => (deg * Math.PI) / 180;

  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;

  return R * 2 * Math.asin(Math.sqrt(a));
}
