/**
 * NavigationProvider (§12) : abstraction remplaçable. Les liens ci-dessous
 * utilisent les schémas d'URL publics documentés, sans clé API ni suivi.
 */
export interface NavigationProvider { readonly name: string; directionsUrl(destination: string): string }

export const GoogleMaps: NavigationProvider = {
  name: "Google Maps",
  directionsUrl: (dest) => `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(dest)}`,
};
export const AppleMaps: NavigationProvider = {
  name: "Plans (Apple)",
  directionsUrl: (dest) => `https://maps.apple.com/?daddr=${encodeURIComponent(dest)}`,
};
export const Waze: NavigationProvider = {
  name: "Waze",
  directionsUrl: (dest) => `https://waze.com/ul?q=${encodeURIComponent(dest)}&navigate=yes`,
};
export const NAVIGATION_PROVIDERS: NavigationProvider[] = [GoogleMaps, AppleMaps, Waze];
