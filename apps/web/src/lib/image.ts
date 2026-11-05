const MAX_SIDE = 1600;

/**
 * Shrinks a phone photo before it is sent: a receipt photo straight off a camera is several megabytes, and the
 * connection at the wash may be slow. Long side 1600px, JPEG, which stays readable and lands near 200-400 KB.
 */
export async function shrinkPhoto(file: File): Promise<Blob> {
  let bitmap: ImageBitmap;
  try {
    // "from-image" turns a sideways phone photo upright.
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new Error('That picture could not be read. Take the photo again.');
  }
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This phone cannot prepare the photo. Try again.');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.8));
  if (!blob) throw new Error('This phone cannot prepare the photo. Try again.');
  return blob;
}
