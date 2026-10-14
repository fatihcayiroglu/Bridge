// server/tests/svg-sanitizer-encoded-schemes.test.ts
//
// An uploaded SVG is parsed as XML by the browser: numeric character
// references in attribute values are decoded BEFORE the value is used as a
// URL, and URL parsing drops ASCII tab/newline. The sanitizer must therefore
// judge what the browser will act on, not the raw bytes. A link is a link
// under any namespace prefix bound to XLink, not only under `xlink:`.
//
// Serving adds a `sandbox` CSP to every SVG (app/createApp.ts,
// middleware/uploadAuthz.ts); these tests keep the sanitizer itself honest so
// the file is safe even where that header is not applied.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { isSvgSafe, sanitizeSvgFile, sanitizeSvgString } from '../lib/svgSanitizer';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-svg-'));
afterAll(() => fs.rmSync(DIR, { recursive: true, force: true }));
let n = 0;
async function sanitize(svg: string) {
  const file = path.join(DIR, `case-${++n}.svg`);
  fs.writeFileSync(file, svg);
  const result = await sanitizeSvgFile(file);
  return { result, written: fs.readFileSync(file, 'utf8') };
}
/** What a browser would hand to URL parsing, for any attribute in the file. */
const browserSees = (text: string) => text
  .replace(/&#(?:x([0-9a-f]+)|([0-9]+));?/gi, (_m, hex, dec) => String.fromCodePoint(hex ? parseInt(hex, 16) : Number(dec)))
  .replace(/[\t\n\r]/g, '');
const XL = 'xmlns="http://www.w3.org/2000/svg" xmlns:xl="http://www.w3.org/1999/xlink"';

describe('a javascript: link cannot survive behind encoding or another XLink prefix', () => {
  it.each([
    ['one letter of the scheme as a decimal reference, under a custom XLink prefix', `<svg ${XL}><a xl:href="j&#97;vascript:alert(document.domain)"><text>x</text></a></svg>`],
    ['an encoded tab inside the scheme, which URL parsing drops', `<svg ${XL}><a xl:href="java&#9;script:alert(1)"><text>x</text></a></svg>`],
    ['a hexadecimal reference with an upper-case marker', `<svg ${XL}><a xl:href="&#X6A;avascript:alert(1)"><text>x</text></a></svg>`],
    ['the plain scheme under a custom prefix', `<svg ${XL}><a xl:href="javascript:alert(1)"><text>x</text></a></svg>`],
  ])('%s', async (_name, svg) => {
    const { result, written } = await sanitize(svg);
    // Either refused outright, or stored without any javascript: URL left.
    if (result.safe) expect(browserSees(written)).not.toMatch(/javascript\s*:/i);
    expect(result.safe && /javascript\s*:/i.test(browserSees(written))).toBe(false);
  });

  it('an encoded scheme in a shape the attribute pass cannot parse is refused as residual danger', async () => {
    // "<a/xl:href=…>" is not well-formed XML, but an HTML parser accepts it.
    const svg = `<svg ${XL}><a/xl:href="j&#97;vascript:alert(1)">x</a></svg>`;
    const { result, written } = await sanitize(svg);
    expect(result.safe).toBe(false);
    expect(result.stripped).toContain(`residual:${/javascript\s*:/i}`);
    expect(written).toBe(svg);
  });

  it('every href is removed whatever its namespace prefix, as xlink:href already was', () => {
    const { clean, stripped } = sanitizeSvgString(`<svg ${XL}><a xl:href="https://evil.test/"><text>x</text></a></svg>`);
    expect(clean).not.toContain('href');
    expect(stripped).toContain('attr:xl:href');
  });

  it('a dangerous value is judged after decoding, also on attributes that are not links', () => {
    for (const style of [`fill:url('j&#97;vascript:x')`, `fill:url('java&#9;script:x')`, `fill:url('java&#x0A;script:x')`]) {
      const { clean, stripped } = sanitizeSvgString(`<svg><rect style="${style}"/></svg>`);
      expect(clean).toBe('<svg><rect/></svg>');
      expect(stripped).toEqual(['attr:style=<dangerous-value>']);
    }
  });

  it('out-of-range or NUL character references neither crash the check nor hide a scheme', () => {
    // String.fromCodePoint(0x110000) throws; an upload must be judged, not crash.
    const benign = '<svg><rect id="&#x110000;&#0;&#99999999;" width="1"/></svg>';
    expect(sanitizeSvgString(benign)).toEqual({ clean: benign, stripped: [] });
    const { stripped } = sanitizeSvgString(`<svg><rect style="fill:url('&#x110000;j&#97;vascript:x')"/></svg>`);
    expect(stripped).toEqual(['attr:style=<dangerous-value>']);
  });

  it('control: ordinary references and attributes are left alone', () => {
    const svg = '<svg><text x="1" y="2" fill="#123456">caf&#233; &amp; tea</text></svg>';
    expect(sanitizeSvgString(svg)).toEqual({ clean: svg, stripped: [] });
    expect(isSvgSafe(svg)).toBe(true);
  });
});

describe('isSvgSafe never calls an unclean document safe', () => {
  it.each([
    ['a script element written without whitespace', '<svg><script/src=//evil.test/x.js></svg>'],
    ['an event handler after a slash', '<svg/onload=alert(1)>'],
    ['an encoded scheme under a custom prefix', `<svg ${XL}><a xl:href="j&#97;vascript:alert(1)">x</a></svg>`],
  ])('%s', (_name, svg) => {
    expect(isSvgSafe(svg)).toBe(false);
  });
});

describe('sanitizer arms that were never exercised', () => {
  it('single-quoted and unquoted handler values are removed like double-quoted ones', () => {
    const single = sanitizeSvgString("<svg><rect onclick='alert(1)' width='1'/></svg>");
    expect(single.clean).toBe("<svg><rect width='1'/></svg>");
    const bare = sanitizeSvgString('<svg><rect onclick=alert(1) width=1 /></svg>');
    expect(bare.clean).toBe('<svg><rect width=1 /></svg>');
    expect(bare.stripped).toEqual(['attr:onclick']);
  });

  it('a javascript: value on an attribute that is not a link is still removed', () => {
    const { clean, stripped } = sanitizeSvgString('<svg><rect fill="javascript:alert(1)" width="1"/></svg>');
    expect(clean).toBe('<svg><rect width="1"/></svg>');
    expect(stripped).toEqual(['attr:fill=<dangerous-value>']);
  });

  it('an entity-encoded javascript: src is removed by the decoded value check', () => {
    const { clean, stripped } = sanitizeSvgString('<svg><image src="&#106;avascript:alert(1)"/></svg>');
    expect(clean).toBe('<svg><image/></svg>');
    expect(stripped).toEqual(['attr:src=<dangerous-value>']);
  });

  it('any encoded "j" or ":" in the document still neutralises every src value (conservative pass)', () => {
    // Harmless on its own, but the encoded-protocol pass does not judge
    // meaning: once an encoded letter appears, src/action values become "#".
    const { clean, stripped } = sanitizeSvgString('<svg><image src="img/&#106;oy.png"/></svg>');
    expect(clean).toBe('<svg><image src="#"/></svg>');
    expect(stripped).toEqual(['encoded-proto:src']);
  });

  it('processing instructions other than the XML declaration are removed', () => {
    const { clean, stripped } = sanitizeSvgString('<?xml version="1.0"?><?xml-stylesheet href="https://evil.test/x.css"?><svg/>');
    expect(clean).toBe('<?xml version="1.0"?><svg/>');
    // Its href is removed by the attribute pass first, then the instruction itself.
    expect(stripped).toEqual(['attr:href', 'processing-instruction']);
  });

  it('content that cannot be stripped is refused and the file is left untouched', async () => {
    const svg = '<svg><script/src=//evil.test/x.js></svg>';
    const { result, written } = await sanitize(svg);
    expect(result).toMatchObject({ safe: false, rewritten: false });
    expect(result.stripped.some((s) => s.startsWith('residual:'))).toBe(true);
    expect(written).toBe(svg);
  });
});
