import { apiFile } from './api';

/** A computer has a mouse and a printer to reach; a phone has a share sheet. */
export const wantsPrint = () => !window.matchMedia('(pointer: coarse)').matches;

export type ReceiptOutcome = 'shared' | 'cancelled' | 'printed' | 'downloaded' | 'link';

function save(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * Gets a receipt to the customer. On a phone: the PDF goes through the share sheet (WhatsApp, Messages, Mail),
 * or is saved when the phone cannot share files. On a computer: the receipt opens in the window that was
 * opened for it and its print dialog comes up.
 */
export async function sendReceipt(token: string, filename: string, printWindow: Window | null): Promise<ReceiptOutcome> {
  if (wantsPrint()) {
    if (!printWindow) {
      await navigator.clipboard.writeText(`${window.location.origin}/r/${token}`);
      return 'link';
    }
    printWindow.location.href = `/r/${token}?print=1`;
    return 'printed';
  }

  const blob = await apiFile(`/receipts/${encodeURIComponent(token)}/pdf`);
  const file = new File([blob], filename, { type: 'application/pdf' });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'Your receipt' });
      return 'shared';
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return 'cancelled'; // they closed the sheet
    }
  }
  save(blob, filename);
  return 'downloaded';
}
