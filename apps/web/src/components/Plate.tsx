/** A Ghana number plate: white, navy border, with the blue "GH" flag strip on the left. */
export function Plate({ plate, size = 'md' }: { plate: string; size?: 'sm' | 'md' | 'lg' }) {
  return <span className={`plate plate-${size}`}>{plate.toUpperCase()}</span>;
}
