import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';
import { formatGHS, type ReceiptDto } from '@niinas/shared';

const require = createRequire(import.meta.url);
const font = (name: string) => require.resolve(`@fontsource/${name}`);

// The app's own typeface. It has no cedi sign, so that one character comes from Noto Sans.
const REGULAR = font('hanken-grotesk/files/hanken-grotesk-latin-400-normal.woff');
const MEDIUM = font('hanken-grotesk/files/hanken-grotesk-latin-600-normal.woff');
const CEDI = font('noto-sans/files/noto-sans-latin-ext-600-normal.woff');

/** The logo, trimmed to its edges so it can be placed exactly. 688 x 334. */
const LOGO = fileURLToPath(new URL('../assets/niinas-logo.png', import.meta.url));
const LOGO_RATIO = 334 / 688;

// The brand's own blue and red, taken from the logo.
const BLUE = '#036fdb';
const RED_BRAND = '#f3020b';
const PANEL = '#f3f6fb';

const INK = '#1a1d23';
const MUTED = '#6b7280';
const NAVY = '#1c2d4f';
const LINE = '#d9dce1';
const GREEN = '#17803d';
const AMBER = '#b45309';
const RED = '#b91c1c';

const MARGIN = 36;

type Doc = InstanceType<typeof PDFDocument>;

/** Draws an amount such as GH₵12.50 ending at `right`, switching to the cedi font for the sign. */
function money(doc: Doc, text: string, right: number, y: number, size: number, face: string, color: string) {
  const parts = text.split('₵');
  const pieces: { text: string; face: string }[] = parts.flatMap((p, i) => (i === 0 ? [{ text: p, face }] : [{ text: '₵', face: 'cedi' }, { text: p, face }]));
  doc.fontSize(size);
  const widths = pieces.map((p) => doc.font(p.face).widthOfString(p.text));
  let x = right - widths.reduce((a, b) => a + b, 0);
  doc.fillColor(color);
  pieces.forEach((p, i) => {
    doc.font(p.face).text(p.text, x, y, { lineBreak: false });
    x += widths[i]!;
  });
}

const when = (iso: string) =>
  new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Accra' }).format(new Date(iso));

/** The receipt as a one-page PDF (A5): the same bill the customer sees on the link, nothing more. */
export function receiptPdf(r: ReceiptDto): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A5', margin: MARGIN, info: { Title: `Receipt ${r.number}`, Author: 'Niinas Wash' } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.registerFont('regular', REGULAR).registerFont('medium', MEDIUM).registerFont('cedi', CEDI);

    const pageW = doc.page.width;
    const pageH = doc.page.height;
    const left = MARGIN;
    const right = pageW - MARGIN;
    const width = right - left;
    const rule = (y: number, color = LINE, w = 0.6) => doc.moveTo(left, y).lineTo(right, y).lineWidth(w).strokeColor(color).stroke();
    const caps = (text: string, x: number, y: number, opts: { width?: number; align?: 'left' | 'right' | 'center' } = {}) =>
      doc.font('medium').fontSize(7.5).fillColor(MUTED).text(text.toUpperCase(), x, y, { characterSpacing: 1.1, lineBreak: false, ...opts });

    // The brand bar across the top: blue with a short red sweep at the end.
    doc.rect(0, 0, pageW, 7).fill(BLUE);
    doc.rect(pageW - 90, 0, 90, 7).fill(RED_BRAND);

    // The logo on the left, the receipt number and date on the right.
    const logoW = 146;
    const logoH = logoW * LOGO_RATIO;
    const top = 26;
    doc.image(LOGO, left - 1, top, { width: logoW });
    caps('Receipt', left, top + 6, { width, align: 'right' });
    doc.font('medium').fontSize(17).fillColor(NAVY).text(r.number, left, top + 19, { width, align: 'right', lineBreak: false });
    doc.font('regular').fontSize(9).fillColor(MUTED).text(when(r.at), left, top + 42, { width, align: 'right', lineBreak: false });

    // Who it is for.
    let y = top + logoH + 14;
    doc.roundedRect(left, y, width, 46, 5).fill(PANEL);
    doc.rect(left, y, 3, 46).fill(BLUE);
    caps(r.plate ? 'Vehicle' : 'Customer', left + 16, y + 9);
    doc.font('medium').fontSize(16).fillColor(INK).text(r.plate ? r.plate.toUpperCase() : 'Walk-in customer', left + 16, y + 21, { lineBreak: false });
    const state = r.voided ? { text: 'Cancelled', color: RED } : r.balance > 0 ? { text: 'Part paid', color: AMBER } : { text: 'Paid in full', color: GREEN };
    doc.font('medium').fontSize(9);
    const pillW = doc.widthOfString(state.text) + 22;
    doc.roundedRect(right - pillW - 12, y + 14, pillW, 20, 10).fill(state.color);
    doc.fillColor('#ffffff').text(state.text, right - pillW - 12, y + 20, { width: pillW, align: 'center', lineBreak: false });
    y += 46 + 18;

    if (r.voided) {
      doc.rect(left, y, 3, 28).fill(RED);
      doc.font('medium').fontSize(10.5).fillColor(RED).text('This job was cancelled. Nothing is owed.', left + 12, y + 8, { lineBreak: false });
      y += 42;
    }

    // The bill: item, how many, amount.
    const qtyRight = right - 92;
    const header = (at: number) => {
      caps('Item', left, at);
      caps('Qty', qtyRight - 40, at, { width: 40, align: 'right' });
      caps('Amount', right - 80, at, { width: 80, align: 'right' });
      rule(at + 14, NAVY, 1);
      return at + 24;
    };
    y = header(y);
    // A long list gets tighter rows so a normal receipt stays on one page.
    const compact = r.lines.length > 6;
    const FOOTER = 118;
    for (const l of r.lines) {
      if (y > pageH - FOOTER - 130) {
        doc.addPage();
        y = header(MARGIN);
      }
      const size = compact ? 10 : 11.5;
      doc.font('regular').fontSize(size).fillColor(INK);
      const h = doc.heightOfString(l.name, { width: qtyRight - 50 - left });
      doc.text(l.name, left, y, { width: qtyRight - 50 - left });
      doc.font('regular').fontSize(size).fillColor(MUTED).text(String(l.quantity), qtyRight - 40, y, { width: 40, align: 'right', lineBreak: false });
      money(doc, formatGHS(l.price), right, y, size, 'medium', INK);
      y += Math.max(h, size + 2) + (compact ? 4 : 8);
      rule(y - (compact ? 1 : 3), LINE, 0.4);
      y += compact ? 3 : 5;
    }
    y += 4;

    // The totals, on the right.
    const row = (label: string, amount: string, color = MUTED, face = 'regular', size = 10.5) => {
      doc.font(face).fontSize(size).fillColor(color).text(label, right - 190, y, { lineBreak: false });
      money(doc, amount, right, y, size, face, color);
      y += size + 8;
    };
    if (r.discount > 0) {
      row('Subtotal', formatGHS(r.subtotal));
      row('Discount', `− ${formatGHS(r.discount)}`);
      y += 2;
    }
    doc.roundedRect(right - 190, y, 190, 40, 6).fill(NAVY);
    doc.font('medium').fontSize(8).fillColor('#c9d6ee').text('TOTAL', right - 178, y + 16, { characterSpacing: 1.1, lineBreak: false });
    money(doc, formatGHS(r.total), right - 12, y + 9, 21, 'medium', '#ffffff');
    y += 40 + 12;

    if (!r.voided) {
      row('Paid', formatGHS(r.paid));
      if (r.balance > 0) row('Still to pay', formatGHS(r.balance), AMBER, 'medium', 12);
    }

    // The foot: a thank you, and the brand bar again. (The logo already carries the tagline.)
    const footY = pageH - 62;
    rule(footY, LINE, 0.6);
    doc.font('regular').fontSize(9.5).fillColor(MUTED).text('Thank you for choosing Niinas Wash', left, footY + 12, { width, align: 'center', lineBreak: false });
    doc.rect(0, pageH - 7, pageW, 7).fill(BLUE);
    doc.rect(0, pageH - 7, 90, 7).fill(RED_BRAND);
    doc.end();
  });
}
