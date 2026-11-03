// Reports download as CSV, which Excel, Sheets and Numbers all open.

export type CsvCell = string | number | null;

/** Spreadsheets run text that starts with = + - or @ as a formula. A leading quote stops that. */
export function csvCell(value: CsvCell): string {
  let s = value === null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: CsvCell[][]): string {
  return rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/** 1250 pesewas -> "12.50": a plain number a spreadsheet can add up. */
export const cedis = (pesewas: number): string => (pesewas / 100).toFixed(2);

/** Saves text as a file. The byte-order mark makes Excel read the ₵ and other letters properly. */
export function downloadCsv(filename: string, rows: CsvCell[][]): void {
  const url = URL.createObjectURL(new Blob(['﻿', toCsv(rows)], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
