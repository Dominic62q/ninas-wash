/**
 * A Ghana number plate: white, navy border, with the blue "GH" flag strip on the left.
 * A walk-in sale or a walk-in customer's wash has no plate, so it gets a plain tag in the same spot instead.
 */
export function Plate({ plate, size = 'md', walkIn = 'Walk-in sale' }: { plate: string | null; size?: 'sm' | 'md' | 'lg'; walkIn?: string }) {
  if (!plate) return <span className={`plate plate-walkin plate-${size}`}>{walkIn}</span>;
  return <span className={`plate plate-${size}`}>{plate.toUpperCase()}</span>;
}
