// Printer artwork for the claim-program QR codes (TAPEKING_DISPENSER_FUNNEL_SCOPE.md,
// "QR code and URL spec" → Generator). One vector SVG + PDF per printed URL
// https://<qr.host>/r/<code>[<lot>], error correction Q, 4-module quiet zone included,
// solid black (PDF: DeviceGray 0 = 100% K) on white. Codes and lots come from
// src/content/brands/<brand>/claim.yaml; files land in qr/<brand>/ with a README for
// the printer. Output is deterministic (no timestamps), so re-running only changes
// files when the URLs do.
//
//   npm run qr -- [--brand=tape-king] [--lot=26a] [--mm=22] [--out=qr/tape-king]
//
// Static codes on purpose: /r/<code> is our own redirect (it logs the scan and can be
// repointed in claim.yaml), so no QR service sits between a roll and the site and
// nothing breaks if a subscription lapses while rolls are still in circulation.
import QRCode from 'qrcode';
import { parse } from 'yaml';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const QUIET = 4; // modules of white border, per the print spec
const EC = 'Q';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, '').split('=');
    return [k, v.join('=') || 'true'];
  })
);
const brand = args.brand ?? 'tape-king';
const mm = Number(args.mm ?? 22);
const outDir = args.out ?? join('qr', brand);
if (!Number.isFinite(mm) || mm < 10) throw new Error('--mm must be a size in millimetres (≥ 10)');

type Code = { code: string; line: string; label: string };
const program = parse(readFileSync(join('src', 'content', 'brands', brand, 'claim.yaml'), 'utf8'));
const { host, codes, lots = [], typed_path: typedPath } = program.qr as {
  host: string;
  codes: Code[];
  lots?: string[];
  typed_path: string;
};
const allLots: string[] = [...new Set([...lots, ...(args.lot ? String(args.lot).split(',') : [])])];
for (const lot of allLots) {
  if (!/^[0-9][0-9a-z]{0,7}$/.test(lot)) throw new Error(`lot "${lot}" must start with a digit (a-z0-9, ≤ 8 chars)`);
}

type Matrix = { size: number; dark: (row: number, col: number) => boolean };

function matrix(url: string) {
  const qr = QRCode.create(url, { errorCorrectionLevel: EC });
  const m = qr.modules;
  return { version: qr.version, m: { size: m.size, dark: (r: number, c: number) => Boolean(m.get(r, c)) } as Matrix };
}

/** Horizontal runs of dark modules, in quiet-zone-inclusive module coordinates. */
function runs(m: Matrix): [x: number, y: number, w: number][] {
  const out: [number, number, number][] = [];
  for (let r = 0; r < m.size; r++) {
    for (let c = 0; c < m.size; ) {
      if (!m.dark(r, c)) {
        c++;
        continue;
      }
      const start = c;
      while (c < m.size && m.dark(r, c)) c++;
      out.push([start + QUIET, r + QUIET, c - start]);
    }
  }
  return out;
}

function svg(url: string, m: Matrix): string {
  const n = m.size + QUIET * 2;
  const d = runs(m)
    .map(([x, y, w]) => `M${x} ${y}h${w}v1h-${w}z`)
    .join('');
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${mm}mm" height="${mm}mm" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges">`,
    `<title>${url}</title>`,
    `<rect width="${n}" height="${n}" fill="#fff"/>`,
    `<path fill="#000" d="${d}"/>`,
    '</svg>',
    '',
  ].join('\n');
}

function pdf(url: string, m: Matrix): Buffer {
  const n = m.size + QUIET * 2;
  const pt = (mm * 72) / 25.4;
  const s = (pt / n).toFixed(6);
  const rects = runs(m)
    .map(([x, y, w]) => `${x} ${n - y - 1} ${w} 1 re`)
    .join('\n');
  // White square for the whole symbol, then every dark run as one filled path.
  const content = `q\n${s} 0 0 ${s} 0 0 cm\n1 g\n0 0 ${n} ${n} re f\n0 g\n${rects}\nf\nQ\n`;
  const esc = (t: string) => t.replace(/[\\()]/g, (ch) => `\\${ch}`);
  const W = pt.toFixed(4);
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${W}] /Contents 4 0 R /Resources << >> >>`,
    `<< /Length ${content.length} >>\nstream\n${content}endstream`,
    `<< /Title (${esc(url)}) /Producer (fogo-brand-sites scripts/make-qr.ts) >>`,
  ];
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) body += `${String(off).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'ascii');
}

mkdirSync(outDir, { recursive: true });
const rows: string[] = [];
for (const c of codes) {
  for (const lot of ['', ...allLots]) {
    const name = `${c.code}${lot}`;
    const url = `https://${host}/r/${name}`;
    const { version, m } = matrix(url);
    writeFileSync(join(outDir, `${name}.svg`), svg(url, m));
    writeFileSync(join(outDir, `${name}.pdf`), pdf(url, m));
    const n = m.size + QUIET * 2;
    rows.push(
      `| \`${name}.svg\` / \`${name}.pdf\` | ${c.label}${lot ? ` · lot ${lot}` : ''} | ${url} | ${version} (${m.size}×${m.size}) | ${(mm / n).toFixed(2)} mm |`
    );
    console.log(`${name.padEnd(10)} ${url}  v${version}  ${m.size}×${m.size} + ${QUIET}-module quiet zone`);
  }
}

writeFileSync(
  join(outDir, 'README.md'),
  `# ${brand} QR codes — printer artwork

Generated by \`npm run qr -- --brand=${brand}${allLots.length ? ` --lot=${allLots.join(',')}` : ''} --mm=${mm}\` from
\`src/content/brands/${brand}/claim.yaml\` (do not edit these files by hand; re-run the script).

| Files | Prints on | Encodes | QR version | Module size at ${mm} mm |
| --- | --- | --- | --- | --- |
${rows.join('\n')}

Print spec (TAPEKING_DISPENSER_FUNNEL_SCOPE.md, "QR code and URL spec"):

- Error correction ${EC}. Each file is ${mm} × ${mm} mm **including** the ${QUIET}-module white quiet zone — place
  it as is; never crop the white border or set other artwork inside it.
- Solid black on white (PDF: 100% K). Vector, so it can scale up; don't shrink it below about 18 mm wide.
- Print the fallback text next to the code: **${host}/${typedPath}**
- Before sign-off, scan a printed proof on a curved core at arm's length with both an iPhone and an Android
  phone; each code must open \`https://www.${host}/claim/?src=qr&sku=<code>…\`.

The URLs are permanent once rolls ship. Where a code lands is set in \`claim.yaml\` (\`qr.codes[].target\`), so
it can be repointed later without reprinting.
`
);
console.log(`\nwrote ${rows.length * 2} files + README.md to ${outDir}/`);
