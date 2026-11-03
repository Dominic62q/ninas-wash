/**
 * "GN 8806-23", "gn8806-23" and "GN-8806 23" are the same car.
 * The normalised form is what we store as the unique key and search on.
 */
export function normalizePlate(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '');
}
