import { createRequire } from 'node:module';
import PDFDocument from 'pdfkit';
import { formatGHS, type ReceiptDto } from '@niinas/shared';

const require = createRequire(import.meta.url);
const font = (name: string) => require.resolve(`@fontsource/${name}`);

// The app's own typeface. It has no cedi sign, so that one character comes from Noto Sans.
const REGULAR = font('hanken-grotesk/files/hanken-grotesk-latin-400-normal.woff');
const MEDIUM = font('hanken-grotesk/files/hanken-grotesk-latin-600-normal.woff');
const CEDI = font('noto-sans/files/noto-sans-latin-ext-600-normal.woff');

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

    const left = MARGIN;
    const right = doc.page.width - MARGIN;
    const width = right - left;
    const rule = (y: number) => doc.moveTo(left, y).lineTo(right, y).lineWidth(0.6).strokeColor(LINE).stroke();

    doc.font('medium').fontSize(22).fillColor(NAVY).text('Niinas Wash', left, MARGIN, { lineBreak: false });
    doc.font('regular').fontSize(9.5).fillColor(MUTED).text(`Receipt ${r.number}`, left, MARGIN + 30, { lineBreak: false });
    doc.text(when(r.at), left, MARGIN + 30, { width, align: 'right', lineBreak: false });

    let y = MARGIN + 58;
    doc.font('medium').fontSize(17).fillColor(INK).text(r.plate.toUpperCase(), left, y, { lineBreak: false });
    y += 34;

    if (r.voided) {
      doc.rect(left, y, 3, 30).fill(RED);
      doc.font('medium').fontSize(10.5).fillColor(RED).text('This job was cancelled. Nothing is owed.', left + 12, y + 9, { lineBreak: false });
      y += 44;
    }

    rule(y);
    y += 12;
    for (const l of r.lines) {
      if (y > doc.page.height - 190) {
        doc.addPage();
        y = MARGIN;
      }
      const label = l.quantity > 1 ? `${l.name}  × ${l.quantity}` : l.name;
      doc.font('regular').fontSize(11.5).fillColor(INK);
      const h = doc.heightOfString(label, { width: width - 90 });
      doc.text(label, left, y, { width: width - 90 });
      money(doc, formatGHS(l.price), right, y, 11.5, 'medium', INK);
      y += Math.max(h, 14) + 10;
    }
    rule(y);
    y += 14;

    const row = (label: string, amount: string, color = MUTED, face = 'regular', size = 10.5) => {
      doc.font(face).fontSize(size).fillColor(color).text(label, left, y, { lineBreak: false });
      money(doc, amount, right, y, size, face, color);
      y += size + 9;
    };
    if (r.discount > 0) {
      row('Subtotal', formatGHS(r.subtotal));
      row('Discount', `− ${formatGHS(r.discount)}`);
      y += 2;
    }
    doc.font('medium').fontSize(12.5).fillColor(INK).text('Total', left, y + 6, { lineBreak: false });
    money(doc, formatGHS(r.total), right, y, 24, 'medium', NAVY);
    y += 40;

    if (!r.voided) {
      row('Paid', formatGHS(r.paid));
      if (r.balance > 0) row('Still to pay', formatGHS(r.balance), AMBER, 'medium', 12);
      else {
        doc.font('medium').fontSize(12).fillColor(GREEN).text('Paid in full', left, y, { lineBreak: false });
        y += 21;
      }
    }

    doc.font('regular').fontSize(9.5).fillColor(MUTED).text('Thank you for choosing Niinas Wash', left, doc.page.height - MARGIN - 24, { width, align: 'center', lineBreak: false });
    doc.end();
  });
}
