import { describe, expect, it } from 'vitest';
import { readTheme } from '#lib/message-view.ts';
import { cidKey, cidRefs, imagePart, partKey, textPart } from './parts.ts';
import { renderMail, srcsetCandidates, type RenderOptions } from './render.ts';

function render(html: string, patch: Partial<RenderOptions> = {}) {
  const out = renderMail(html, {
    remote: false,
    cids: new Map(),
    theme: readTheme(false, false),
    padding: '22px 24px 24px',
    blockedLabel: 'Image blocked',
    ...patch,
  });
  const doc = new DOMParser().parseFromString(out.html, 'text/html');
  return { ...out, doc, body: doc.body };
}

describe('renderMail – sanitizing', () => {
  it('removes scripts, event attributes and javascript: links', () => {
    const { body } = render(
      '<p onclick="alert(1)" onmouseover="x()">Hello</p><script>alert(1)</script>' +
        '<a href="javascript:alert(1)">A</a><img src="x" onerror="alert(1)"><iframe src="https://evil.example"></iframe>' +
        '<object data="x.swf"></object><embed src="x.swf">',
    );
    expect(body.querySelector('script, iframe, object, embed')).toBeNull();
    expect(body.innerHTML).not.toMatch(/onclick|onmouseover|onerror|javascript:/i);
    expect(body.querySelector('p')?.textContent).toBe('Hello');
  });

  it('removes forms and input fields, the text stays', () => {
    const { body } = render(
      '<form action="https://evil.example/login" method="post"><input name="pw" type="password">' +
        '<textarea>t</textarea><select><option>o</option></select><button>Sign in</button></form>',
    );
    expect(body.querySelector('form, input, textarea, select, option, button')).toBeNull();
    expect(body.textContent).toContain('Sign in');
  });

  it('does not let SVG, MathML, meta, base and link through', () => {
    const { body } = render(
      '<svg><image href="https://t.example/p.gif"/></svg><math><mi>x</mi></math>' +
        '<meta http-equiv="refresh" content="0;url=https://evil.example"><base href="https://evil.example/"><link rel="stylesheet" href="https://t.example/a.css">',
    );
    expect(body.querySelector('svg image, math, meta, base, link')).toBeNull();
  });

  it('removes media that load on their own', () => {
    const { body } = render(
      '<video poster="https://t.example/p.jpg"><source src="https://t.example/v.mp4"></video><audio src="https://t.example/a.mp3"></audio>',
    );
    expect(body.querySelector('video, audio, source')).toBeNull();
  });

  it('opens links in a new tab without opener and referrer, anchors stay in the document', () => {
    const { body } = render(
      '<a href="https://example.com/x" target="_self" ping="https://t.example/ping">Link</a><a href="#bottom">Anchor</a>',
    );
    const [link, anchor] = body.querySelectorAll('a');
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link?.hasAttribute('ping')).toBe(false);
    expect(anchor?.hasAttribute('target')).toBe(false);
  });

  it('discards `data-ext-src` from the email (otherwise allowed images would become tiles)', () => {
    const cids = new Map([['logo@x', 'blob:http://localhost/1']]);
    const { body, blocked } = render('<img src="cid:logo@x" data-ext-src="https://a/b.png" width="300" height="100">', {
      cids,
      remote: true,
    });
    expect(blocked).toBe(0);
    expect(body.querySelector('rm-blocked')).toBeNull();
    expect(body.querySelector('img')?.getAttribute('src')).toBe('blob:http://localhost/1');
  });

  it('keeps the attributes of the email `body` and puts the content into `rm-mail`', () => {
    const { body } = render(
      '<html><body bgcolor="#eeeeee" style="background:#eee" class="n" onload="x()" background="https://t.example/bg.gif"><p>x</p></body></html>',
    );
    expect(body.getAttribute('bgcolor')).toBe('#eeeeee');
    expect(body.getAttribute('style')).toBe('background:#eee');
    expect(body.getAttribute('class')).toBe('n');
    expect(body.hasAttribute('onload')).toBe(false);
    expect(body.hasAttribute('background')).toBe(false);
    expect(body.getAttribute('data-ext-src')).toBe('https://t.example/bg.gif');
    expect(body.firstElementChild?.localName).toBe('rm-mail');
  });

  it('keeps stylesheets, also in <head> and with HTML comments, in the head after its own', () => {
    const { body, doc } = render(
      '<html><head><style><!-- .x { color: red } --></style></head><body><p class="x">Red</p></body></html>',
    );
    const [base, style] = doc.head.querySelectorAll('style');
    expect(base?.textContent).toContain('rm-blocked');
    expect(style?.textContent).toContain('.x { color: red }');
    expect(style?.textContent).not.toContain('<!--');
    expect(body.querySelector('style')).toBeNull();
    expect(body.querySelector('rm-mail')?.firstElementChild?.matches('p.x')).toBe(true);
  });

  it('removes comment markers that a single pass would join together', () => {
    const { doc } = render('<html><head><style><<!---->!-- .x { color: red } --!></style></head><body></body></html>');
    const style = doc.head.querySelectorAll('style')[1];
    expect(style?.textContent).toContain('.x { color: red }');
    expect(style?.textContent).not.toContain('<!--');
    expect(style?.textContent).not.toContain('--!>');
  });

  it('strips deeply nested comment markers in linear time', () => {
    const n = 100_000;
    const css = '<!'.repeat(n) + '--'.repeat(n) + ' .x { color: red }';
    const { doc } = render(`<html><head><style>${css}</style></head><body></body></html>`);
    const style = doc.head.querySelectorAll('style')[1];
    expect(style?.textContent).toContain('.x { color: red }');
    expect(style?.textContent).not.toContain('<!');
  });

  it('builds a document of its own with a CSP without scripts and with the message colours', () => {
    const { doc } = render('<p>Hello</p>', { theme: readTheme(true, false) });
    const csp = doc.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content');
    expect(csp).toBe("default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'");
    expect(doc.querySelector('meta[name="referrer"]')?.getAttribute('content')).toBe('no-referrer');
    const css = doc.head.querySelector('style')?.textContent ?? '';
    expect(css).toContain('color-scheme:dark');
    expect(css).toContain(`--fg:${readTheme(true, false).fg}`);
    expect(css).toContain('padding:22px 24px 24px');
  });

  it('allows https: images in the CSP with permission', () => {
    const { doc } = render('<p>Hello</p>', { remote: true });
    expect(doc.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content')).toContain(
      'img-src data: blob: https:',
    );
  });
});

describe('renderMail – external content', () => {
  it('blocks foreign images, counts them and replaces them with tiles', () => {
    const { body, blocked } = render(
      '<img src="https://cdn.example.com/title/titleimage.jpg" width="600" height="250" alt="Title">' +
        '<img src="http://cdn.example.com/logo.png">',
    );
    expect(blocked).toBe(2);
    expect(body.querySelector('img[data-ext-src]')).toBeNull();
    const [withRatio, free] = body.querySelectorAll('rm-blocked');
    expect(withRatio?.className).toBe('r');
    // Dimensions via an empty SVG: the tile shrinks like an image.
    const spacer = withRatio?.querySelector('img');
    expect([spacer?.getAttribute('width'), spacer?.getAttribute('height'), spacer?.alt]).toEqual(['600', '250', '']);
    expect(spacer?.getAttribute('src')).toMatch(/^data:image\/svg\+xml,/);
    expect(withRatio?.querySelector('rm-label')?.textContent).toBe('Image blocked');
    expect(withRatio?.querySelector('rm-name')?.textContent).toBe('titleimage.jpg');
    expect(withRatio?.getAttribute('aria-label')).toBe('Image blocked');
    // Without dimensions full width and 120 px high, only with the name.
    expect(free?.className).toBe('f');
    expect(free?.querySelector('img, rm-label')).toBeNull();
    expect(free?.querySelector('rm-name')?.textContent).toBe('logo.png');
    expect(body.innerHTML).not.toContain('cdn.example.com/title');
  });

  it('removes tracking pixels but still counts them', () => {
    const { body, blocked } = render(
      '<p>Text</p><img src="https://t.example.com/o/abc" width="1" height="1"><img src="https://t.example.com/o/def" style="width:0px;height:0px">',
    );
    expect(blocked).toBe(2);
    expect(body.querySelector('img, rm-blocked')).toBeNull();
  });

  it('shows small images only with the icon', () => {
    const { body } = render('<img src="https://example.com/x.png" width="24" height="24">');
    expect(body.querySelector('rm-blocked')?.className).toBe('s');
    expect(body.querySelector('rm-label, rm-name')).toBeNull();
    // Only with width: 120 px high, with the name.
    const n = render('<img src="https://example.com/y.png" width="300">').body.querySelector('rm-blocked');
    expect(n?.className).toBe('n');
    expect(n?.querySelector('img')?.getAttribute('height')).toBe('120');
  });

  it('carries style, classes, `hidden` and `align` of the image over to the tile', () => {
    const { body } = render(
      '<img src="https://x/m.png" style="display:none" class="mobil" width="300" height="200">' +
        '<img src="https://x/a.png" align="left" width="200" height="200"><img src="https://x/h.png" hidden>',
    );
    const [mobile, left, hidden] = body.querySelectorAll('rm-blocked');
    expect(mobile?.getAttribute('style')).toBe('display:none');
    expect(mobile?.className).toBe('r mobil');
    expect(left?.getAttribute('style')).toBe('float:left;');
    expect(hidden?.hasAttribute('hidden')).toBe(true);
  });

  it('counts no addresses in CSS comments and fonts', () => {
    const { blocked, doc } = render(
      '<style>/* background:url(http://a/b.png) */ @font-face { font-family: X; src: url(https://f.example/x.woff2) } p { color: red }</style><p>x</p>',
    );
    expect(blocked).toBe(0);
    const sheet = doc.head.querySelectorAll('style')[1]?.textContent ?? '';
    expect(sheet).not.toMatch(/font-face|https?:/);
    expect(sheet).toContain('p { color: red }');
  });

  it('splits srcset also without a space after the comma and without a descriptor', () => {
    expect(srcsetCandidates('http://x/a.png, http://x/b.png 2x')).toEqual([
      { url: 'http://x/a.png', descriptor: '' },
      { url: 'http://x/b.png', descriptor: '2x' },
    ]);
    expect(srcsetCandidates('http://x/a.png 1x,http://y/b.png 2x')).toEqual([
      { url: 'http://x/a.png', descriptor: '1x' },
      { url: 'http://y/b.png', descriptor: '2x' },
    ]);
    const { body } = render('<img src="http://x/a.png" srcset="http://x/a.png 1x,http://y/b.png 2x">', {
      remote: true,
    });
    expect(body.querySelector('img')?.getAttribute('srcset')).toBe('https://x/a.png 1x, https://y/b.png 2x');
    const blockedOnly = render('<img srcset="http://x/a.png, http://x/b.png 2x" width="200" height="100">');
    expect(blockedOnly.body.querySelector('rm-name')?.textContent).toBe('a.png');
  });

  it('keeps images with only a height at their height', () => {
    const css = render('<p>x</p>').doc.head.querySelector('style')?.textContent ?? '';
    expect(css).toContain('img{max-width:100%}');
    expect(css).toContain('img[width]{height:auto}');
    expect(css).not.toContain('img{max-width:100%;height:auto}');
  });

  it('counts the same address once', () => {
    const { blocked } = render(
      '<img src="https://t.example/a.png" width="10" height="10"><img src="https://t.example/a.png" width="10" height="10">',
    );
    expect(blocked).toBe(1);
  });

  it('blocks backgrounds in attributes, inline styles and stylesheets', () => {
    const { body, blocked, doc } = render(
      '<style>@import url(https://t.example/a.css); .h { background: url("https://t.example/h.jpg") no-repeat }</style>' +
        '<table background="https://t.example/bg.gif"><tr><td style="background-image: url(https://t.example/td.png)">x</td></tr></table>',
    );
    expect(blocked).toBe(3);
    // Only in `data-ext-src` now, which loads nothing.
    expect(body.innerHTML.replace(/data-ext-src="[^"]*"/g, '')).not.toContain('https://t.example');
    const sheet = doc.head.querySelectorAll('style')[1]?.textContent;
    expect(sheet).toContain('background: none no-repeat');
    expect(sheet).not.toContain('@import');
    expect(body.querySelector('table')?.getAttribute('data-ext-src')).toBe('https://t.example/bg.gif');
    expect(body.querySelector('td')?.getAttribute('style')).toBe('background-image: none');
  });

  it('blocks an unterminated url() at the end of a stylesheet or style attribute', () => {
    const { body, blocked, doc } = render(
      '<style>.h { color: red } .i { background: url("https://t.example/h.jpg</style>' +
        '<p style="background: url(//t.example/p.png">x</p>',
    );
    expect(blocked).toBe(2);
    expect(doc.head.querySelectorAll('style')[1]?.textContent).toBe('.h { color: red } .i { background: none');
    expect(body.querySelector('p')?.getAttribute('style')).toBe('background: none');
  });

  it('does not join the characters around a CSS comment into a new comment', () => {
    const { doc } = render(
      '<style>.a { width: calc(4//**/*2px) } .b { background: url(https://t.example/b.png) }</style>',
    );
    const sheet = doc.head.querySelectorAll('style')[1]?.textContent;
    expect(sheet).toBe('.a { width: calc(4/ *2px) } .b { background: none }');
  });

  it('converts viewport heights into pixels, addresses stay', () => {
    const { body, doc } = render(
      '<style>.hero { min-height: 100vh; height: calc(50dvh - 10px); width: 50vw } ' +
        '.b { background: url("https://t.example/bg-100vh.png") }</style>' +
        '<div class="hero" style="min-height:-12.5svh;max-height:3lvh">x</div>',
      { remote: true },
    );
    const sheet = doc.head.querySelectorAll('style')[1]?.textContent;
    expect(sheet).toContain('min-height: 800px; height: calc(400px - 10px); width: 50vw');
    expect(sheet).toContain('background: url("https://t.example/bg-100vh.png")');
    expect(body.querySelector('div')?.getAttribute('style')).toBe('min-height:-100px;max-height:24px');
  });

  it('recognizes addresses with whitespace and without a scheme', () => {
    const { blocked, body } = render(
      '<img src=" ht\ntps://t.example/a.png " width="50" height="50"><img src="//t.example/b.png">',
    );
    expect(blocked).toBe(2);
    expect(body.querySelectorAll('rm-blocked')).toHaveLength(2);
  });

  it('loads with permission via https and without referrer', () => {
    const { body, blocked } = render(
      '<img src="http://cdn.example.com/a.png" srcset="https://cdn.example.com/a.png 1x, //cdn.example.com/a2.png 2x">' +
        '<div style="background:url(https://cdn.example.com/b.png)">x</div>',
      { remote: true },
    );
    expect(blocked).toBe(0);
    const img = body.querySelector('img');
    expect(img?.getAttribute('src')).toBe('https://cdn.example.com/a.png');
    expect(img?.getAttribute('srcset')).toBe('https://cdn.example.com/a.png 1x, https://cdn.example.com/a2.png 2x');
    expect(img?.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(body.querySelector('div')?.getAttribute('style')).toBe('background:url("https://cdn.example.com/b.png")');
  });

  it('blocks an image only from srcset', () => {
    const { blocked, body } = render(
      '<img srcset="https://t.example/a.png 1x, https://t.example/b.png 2x" width="80" height="80">',
    );
    expect(blocked).toBe(1);
    expect(body.querySelector('rm-blocked')).not.toBe(null);
  });

  it('keeps data: images, discards relative addresses', () => {
    const data = 'data:image/png;base64,iVBORw0KGgo=';
    const { body, blocked } = render(`<img src="${data}"><img src="images/a.png" alt="rel">`);
    expect(blocked).toBe(0);
    const [inline, relative] = body.querySelectorAll('img');
    expect(inline?.getAttribute('src')).toBe(data);
    expect(relative?.hasAttribute('src')).toBe(false);
  });
});

describe('renderMail – embedded images', () => {
  it('shows cid: images as blob URLs, unknown ones stay empty', () => {
    const cids = new Map([['logo@example.com', 'blob:http://localhost/1']]);
    const { body, blocked } = render(
      '<img src="cid:logo%40example.com"><img src="CID:missing@example.com"><td background="cid:logo@example.com"></td>' +
        '<p style="background:url(cid:logo@example.com)">x</p>',
      { cids },
    );
    expect(blocked).toBe(0);
    const [logo, missing] = body.querySelectorAll('img');
    expect(logo?.getAttribute('src')).toBe('blob:http://localhost/1');
    expect(missing?.hasAttribute('src')).toBe(false);
    expect(body.querySelector('p')?.getAttribute('style')).toBe('background:url("blob:http://localhost/1")');
  });

  it('finds the content IDs in the HTML', () => {
    expect([...cidRefs('<img src="cid:Logo%40example.com"><p style="background:url(cid:bg.png)">')]).toEqual([
      'logo@example.com',
      'bg.png',
    ]);
    expect(cidKey('<Image1@Example.com>')).toBe('image1@example.com');
    expect(cidKey('kaputt%zz')).toBe('kaputt%zz');
  });

  it('refers to images from `htmlBody` like to cid: images', () => {
    const html = imagePart('3');
    expect([...cidRefs(html)]).toEqual([partKey('3')]);
    const { body } = render(html, { cids: new Map([[partKey('3'), 'blob:http://localhost/3']]) });
    expect(body.querySelector('img')?.getAttribute('src')).toBe('blob:http://localhost/3');
  });
});

describe('textPart', () => {
  it('masks plain text between HTML parts', () => {
    expect(textPart('<b>a</b> & "b"')).toBe(
      '<div style="white-space:pre-wrap">&#60;b&#62;a&#60;/b&#62; &#38; &#34;b&#34;</div>',
    );
  });
});
