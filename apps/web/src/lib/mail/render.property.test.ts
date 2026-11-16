/**
 * Property-based tests for the mail renderer: random emails built from the
 * pieces that attacks and odd senders use (active content, foreign
 * addresses in every place an image can come from, comment markers and
 * nested markup) must always come out inert.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { readTheme } from '#lib/message-view.ts';
import { renderMail, srcsetCandidates, stripCommentMarkers, type RenderOptions } from './render.ts';

/** Every foreign address in the generated emails lives on this host. */
const TRACKER = 't.example';
const BLOB = 'blob:http://localhost/1';

const OPTIONS: RenderOptions = {
  remote: false,
  cids: new Map([['logo@x', BLOB]]),
  theme: readTheme(false, false),
  padding: '0',
  blockedLabel: 'Image blocked',
};

const urls = fc.constantFrom(
  `https://${TRACKER}/a.png`,
  `http://${TRACKER}/b.gif`,
  `//${TRACKER}/c.png`,
  ` \t https://${TRACKER}/d.png `,
  `HTTPS://${TRACKER}/e.png`,
  `ht\ntps://${TRACKER}/f.png`,
  'javascript:alert(1)',
  'JaVaScRiPt:alert(1)',
  'java&#x09;script:alert(1)',
  '&#106;avascript:alert(1)',
  'vbscript:msgbox(1)',
  'data:text/html,<script>alert(1)</script>',
  'data:image/png;base64,AAAA',
  'cid:logo@x',
  'cid:unknown@x',
  '#top',
  'relative/path.png',
  '',
);

const css = fc.constantFrom(
  'color:red;',
  'background:url(',
  'url(',
  ')',
  '"',
  "'",
  '\\',
  '/*',
  '*/',
  '<!--',
  '-->',
  '--!>',
  '<',
  '!',
  '-',
  '>',
  '@import ',
  '@font-face{',
  '}',
  '{',
  ';',
  'height:100vh;',
  '.5svh',
  'image-set(',
  'expression(alert(1))',
  '</sty',
  'le>',
  `https://${TRACKER}/s.png`,
  `//${TRACKER}/t.png`,
  'cid:logo@x',
  'data:image/png;base64,AAAA',
);

const cssText = fc.array(css, { maxLength: 12 }).map((parts) => parts.join(''));

const attrName = fc.constantFrom(
  'src',
  'srcset',
  'href',
  'background',
  'style',
  'onclick',
  'onerror',
  'ONLOAD',
  'xlink:href',
  'action',
  'formaction',
  'poster',
  'data',
  'ping',
  'data-ext-src',
  'target',
  'width',
  'height',
  'align',
  'hidden',
  'class',
  'id',
  'name',
  'is',
  'bgcolor',
);

const attrValue = fc.oneof(
  { weight: 4, arbitrary: urls },
  { weight: 2, arbitrary: cssText },
  { weight: 1, arbitrary: fc.array(urls, { minLength: 1, maxLength: 3 }).map((list) => list.join(' 1x, ')) },
  { weight: 1, arbitrary: fc.constantFrom('1', '2', '0', '300', '100%', 'left', '_self', 'alert(1)') },
  { weight: 1, arbitrary: fc.string({ maxLength: 6 }) },
);

const quote = fc.constantFrom('"', "'", '');

const attribute = fc
  .tuple(attrName, attrValue, quote)
  .map(([name, value, q]) => ` ${name}=${q}${q ? value.replaceAll(q, '') : value.replace(/[\s>]/g, '')}${q}`);

const tagName = fc.constantFrom(
  'p',
  'div',
  'span',
  'a',
  'area',
  'img',
  'table',
  'td',
  'body',
  'html',
  'head',
  'title',
  'style',
  'script',
  'iframe',
  'frame',
  'object',
  'embed',
  'form',
  'input',
  'button',
  'textarea',
  'select',
  'option',
  'video',
  'audio',
  'source',
  'svg',
  'math',
  'mi',
  'mglyph',
  'foreignObject',
  'annotation-xml',
  'template',
  'noscript',
  'noembed',
  'xmp',
  'base',
  'meta',
  'link',
  'rm-mail',
  'rm-blocked',
);

const markup = fc.oneof(
  {
    weight: 5,
    arbitrary: fc.tuple(tagName, fc.array(attribute, { maxLength: 3 })).map(([t, a]) => `<${t}${a.join('')}>`),
  },
  { weight: 3, arbitrary: tagName.map((t) => `</${t}>`) },
  { weight: 2, arbitrary: cssText.map((text) => `<style>${text}</style>`) },
  {
    weight: 2,
    arbitrary: fc.constantFrom(
      '<!--',
      '-->',
      '--!>',
      '<![CDATA[',
      ']]>',
      '<',
      '>',
      '/',
      '"',
      "'",
      '&lt;',
      '&#60;',
      '&',
    ),
  },
  { weight: 2, arbitrary: fc.string({ maxLength: 8 }) },
);

const email = fc.array(markup, { maxLength: 25 }).map((parts) => parts.join(''));

/** Elements that must never reach the iframe. */
const FORBIDDEN = new Set([
  'script',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'form',
  'input',
  'button',
  'textarea',
  'select',
  'option',
  'video',
  'audio',
  'source',
  'track',
  'svg',
  'math',
  'base',
  'link',
  'meta',
  'noscript',
  'portal',
]);

/** Attributes that carry an address. */
const URL_ATTRS = ['src', 'srcset', 'href', 'background', 'action', 'formaction', 'poster', 'data', 'xlink:href'];

/** An address without the characters the URL parser ignores. */
function plain(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000- ]/g, '').toLowerCase();
}

/** All elements below `root`, also those in the content of `<template>`. */
function elements(root: ParentNode): Element[] {
  return [...root.querySelectorAll('*')].flatMap((el) =>
    el instanceof HTMLTemplateElement ? [el, ...elements(el.content)] : [el],
  );
}

/** Markup of a node with sorted attributes: the same tree, however the attributes are ordered. */
function canonical(node: Node): string {
  const children = [...(node instanceof HTMLTemplateElement ? node.content : node).childNodes].map(canonical).join('');
  if (node instanceof Element) {
    const attrs = [...node.attributes]
      .map((a) => ` ${a.name}=${JSON.stringify(a.value)}`)
      .sort()
      .join('');
    return `<${node.localName}${attrs}>${children}</${node.localName}>`;
  }
  if (node.nodeType === Node.TEXT_NODE) return JSON.stringify(node.textContent);
  if (node.nodeType === Node.COMMENT_NODE) return `<!--${node.textContent}-->`;
  return children;
}

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

describe('renderMail – properties', () => {
  it('never lets active content through', () => {
    fc.assert(
      fc.property(email, fc.boolean(), (html, remote) => {
        const doc = parse(renderMail(html, { ...OPTIONS, remote }).html);
        for (const el of elements(doc)) {
          // The renderer's own markup: the meta tags of the frame and the icon of the tiles.
          if (el.parentElement === doc.head && el.localName === 'meta') continue;
          if (el.closest('rm-blocked > rm-in > svg')) continue;
          expect(FORBIDDEN.has(el.localName), el.localName).toBe(false);
          for (const { name, value } of el.attributes) {
            expect(name.startsWith('on'), name).toBe(false);
            if (URL_ATTRS.includes(name)) expect(plain(value), name).not.toMatch(/^(javascript|vbscript|data:text)/);
          }
        }
      }),
      { numRuns: 300 },
    );
  });

  it('keeps the frame of the document: CSP first, own style, then only the email stylesheets', () => {
    fc.assert(
      fc.property(email, fc.boolean(), (html, remote) => {
        const doc = parse(renderMail(html, { ...OPTIONS, remote }).html);
        const [charset, csp, referrer, base, ...sheets] = [...doc.head.children];
        expect(charset?.getAttribute('charset')).toBe('utf-8');
        expect(csp?.getAttribute('content')).toBe(
          `default-src 'none'; img-src data: blob:${remote ? ' https:' : ''}; style-src 'unsafe-inline'`,
        );
        expect(referrer?.getAttribute('content')).toBe('no-referrer');
        expect(base?.localName).toBe('style');
        for (const sheet of sheets) expect(sheet.localName).toBe('style');
        // Everything of the email sits in `rm-mail`, the only child of `body`.
        expect([...doc.body.children].map((el) => el.localName)).toEqual(['rm-mail']);
      }),
      { numRuns: 300 },
    );
  });

  it('loads nothing from foreign servers without permission, and counts what it blocks', () => {
    fc.assert(
      fc.property(email, (html) => {
        const { html: out, blocked } = renderMail(html, OPTIONS);
        const doc = parse(out);
        const mail = doc.querySelector('rm-mail')!;
        for (const el of elements(mail)) {
          // `src` and `srcset` load only on images (media and frames do not get through at all).
          for (const name of el.localName === 'img' ? ['src', 'srcset', 'background'] : ['background']) {
            const value = el.getAttribute(name);
            if (value !== null) expect(value, name).toMatch(/^(data:image\/|blob:)/i);
          }
        }
        const styles = [
          ...[...doc.head.querySelectorAll('style')].slice(1).map((el) => el.textContent ?? ''),
          ...elements(mail).map((el) => el.getAttribute('style') ?? ''),
        ];
        for (const style of styles) {
          for (const [, address] of style.matchAll(/url\(\s*["']?([^)]*)/gi)) {
            expect(address, style).not.toMatch(/^(https?:|\/\/)/i);
          }
        }
        // Each tile stands for a counted address.
        expect(mail.querySelectorAll('rm-blocked').length > 0 ? blocked > 0 : true).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it('is idempotent: rendering the rendered email again changes nothing', () => {
    // With permission there are no tiles (they are the renderer's own markup, not the email's), and without
    // embedded images no blob URLs (an email must not refer to them, so they disappear the second time).
    const options = { ...OPTIONS, remote: true, cids: new Map<string, string>() };
    const render = (html: string) => {
      const doc = parse(renderMail(html, options).html);
      const sheets = [...doc.head.querySelectorAll('style')].slice(1);
      const mail = doc.querySelector('rm-mail')!;
      return {
        html: sheets.map((el) => el.outerHTML).join('') + mail.innerHTML,
        tree: [...sheets, mail].map(canonical).join(''),
      };
    };
    fc.assert(
      fc.property(email, (html) => {
        const once = render(html);
        expect(render(once.html).tree).toBe(once.tree);
      }),
      { numRuns: 300 },
    );
  });
});

describe('stripCommentMarkers – properties', () => {
  const markerText = fc
    .array(fc.constantFrom('<', '!', '-', '>', '<!--', '-->', '--!>', ' ', 'a', '{}'), { maxLength: 60 })
    .map((parts) => parts.join(''));

  it('leaves no marker, keeps the order of the rest and is idempotent', () => {
    fc.assert(
      fc.property(markerText, (text) => {
        const out = stripCommentMarkers(text);
        expect(out).not.toMatch(/<!--|-->|--!>/);
        expect(stripCommentMarkers(out)).toBe(out);
        // The result is a subsequence of the input: only removed, nothing added or moved.
        let i = 0;
        for (const c of out) {
          i = text.indexOf(c, i) + 1;
          expect(i).toBeGreaterThan(0);
        }
      }),
      { numRuns: 1000 },
    );
  });

  it('removes nothing from text without markers', () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        fc.pre(!/<!--|-->|--!>/.test(text));
        expect(stripCommentMarkers(text)).toBe(text);
      }),
    );
  });
});

describe('srcsetCandidates – properties', () => {
  const srcset = fc
    .array(fc.oneof(urls, fc.constantFrom(',', ' ', '1x', '2x', '100w', '(', ')', ',,'), fc.string({ maxLength: 4 })), {
      maxLength: 12,
    })
    .map((parts) => parts.join(''));

  it('yields only addresses without whitespace that occur in the input', () => {
    fc.assert(
      fc.property(srcset, (value) => {
        for (const { url } of srcsetCandidates(value)) {
          expect(url).not.toBe('');
          expect(url).not.toMatch(/\s/);
          expect(value).toContain(url);
        }
      }),
      { numRuns: 1000 },
    );
  });
});
