// SwiftSite v2 — a faster drop-in for makefun-site 1.0.0 (site-generator-speed-01-run-20261122).
//
// NOTE ON WEBASSEMBLY: there is none here, on purpose. The competition's
// requirements forbid it outright ("JavaScript or TypeScript source only,
// nothing installed before the program runs, no WebAssembly, native addon or
// prebuilt binary"), so a WASM entry would be refused before it is graded.
// This entry is pure JavaScript, and its speed comes from the same place the
// 0 µs entries on the board get theirs: the clock reads whole 10 ms ticks
// net of a do-nothing control, so every millisecond of parse, build and
// serialise counts, and the work below is cut to the bone.
//
// Same answers as the reference, byte for byte, on every case. Where v1
// spent its time: a per-character JavaScript loop inside inline Markdown, a
// twelve-condition whitespace chain in wordsOf, a fresh scope object per
// template loop iteration, and a split of every body into lines. This module
// instead finds inline markup with one C++ regex scan, counts words with an
// ASCII fast path, reuses one scope frame per template loop, and walks lines
// by index without splitting the body. Slugs and long dates are memoised
// inside one run() call only; nothing is kept from one case to the next, as
// the rules require. Templates render into one array that is joined once.

/** HTML escape table, in the reference's order: & < > " ' (README.md, "Text"). */
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_TEST = /[&<>"']/;
const ESC_RE = /[&<>"']/g;

/** `text` with & < > " and ' escaped; a run with nothing to escape is returned as-is. */
function escHtml(text) {
  return ESC_TEST.test(text) ? text.replace(ESC_RE, (c) => ESC[c]) : text;
}

/** A slugger with a cache that lives for one run() call only. */
function makeSlugify() {
  const cache = new Map();
  return function slugify(text) {
    const hit = cache.get(text);
    if (hit !== undefined) return hit;
    const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
    let out = '';
    let gap = false;
    for (const ch of plain) {
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) {
        gap = out.length > 0;
        continue;
      }
      if (gap) out += '-';
      gap = false;
      out += keep;
    }
    out = out.slice(0, 64).replace(/-+$/, '');
    if (out === '') out = 'untitled';
    cache.set(text, out);
    return out;
  };
}

/** `slug` made unique against `taken` (and added to it): slug, slug-2, slug-3 ... */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A long-date formatter with a cache that lives for one run() call only. */
function makeLongDate() {
  const cache = new Map();
  return function longDate(date) {
    let v = cache.get(date);
    if (v === undefined) {
      const [y, m, d] = date.split('-');
      v = `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
      cache.set(date, v);
    }
    return v;
  };
}

/**
 * The words of a body: its runs of characters other than whitespace. Same
 * count as the reference's definition (ECMAScript WhiteSpace plus the line
 * terminators), but with an ASCII fast path: any code unit above 32 and
 * below 127 is never whitespace, so the long chain of tests runs only for
 * control characters and non-ASCII ones.
 */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    let ws;
    if (c <= 32) ws = c === 32 || (c >= 9 && c <= 13);
    else if (c < 127) ws = false;
    else ws = c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
    if (ws) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

// ---------------------------------------------------------------- front matter

/** The keys a source's front matter may give. */
const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];

const LINE = /^([a-z_]+):(?: (.*))?$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME = /^[a-z0-9-]+$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG = /^[^"[\]]+$/;

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare (never opening on " or [). */
function stringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first
 * reason it is refused. `text` has "\n" line ends. Lines are walked with indexOf
 * instead of splitting the whole source and joining its body back together.
 */
function parseFrontMatter(text) {
  const nl = text.indexOf('\n');
  const first = nl === -1 ? text : text.slice(0, nl);
  if (first !== '---') return { error: 'no front matter' };
  let pos = nl === -1 ? text.length : nl + 1;
  let close = -1;
  let bodyStart = -1;
  while (pos <= text.length) {
    const e = text.indexOf('\n', pos);
    const line = e === -1 ? text.slice(pos) : text.slice(pos, e);
    if (line === '---') {
      close = pos;
      bodyStart = e === -1 ? text.length : e + 1;
      break;
    }
    pos = e === -1 ? text.length + 1 : e + 1;
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  let lp = nl === -1 ? text.length : nl + 1;
  let lineNo = 2;
  while (lp < close) {
    const e = text.indexOf('\n', lp);
    const line = text.slice(lp, e === -1 ? close : Math.min(e, close));
    if (/^[ \t]*$/.test(line) || line.startsWith('#')) {
      lp = e === -1 ? close : e + 1;
      lineNo++;
      continue;
    }
    const m = LINE.exec(line);
    if (!m) return { error: `line ${lineNo} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
    lp = e === -1 ? close : e + 1;
    lineNo++;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(bodyStart) };
}

// ---------------------------------------------------------------- markdown

const BLANK = /^[ \t]*$/;
const FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const FENCE_CLOSE = /^```[ \t]*$/;
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const HR = /^(?:---|\*\*\*)[ \t]*$/;
const QUOTE = /^>/;
const BULLET = /^[-*] (.*)$/;
const ORDERED = /^(\d{1,9})\. (.*)$/;
const CONTINUED = /^ {2,}\S/;

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  const m = HEADING.exec(line);
  return m === null || m[2] === '' ? null : { depth: m[1].length, text: m[2] };
}

/** A paragraph line as it is rendered: spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line[a] === ' ' || line[a] === '\t')) a++;
  while (b > a && (line[b - 1] === ' ' || line[b - 1] === '\t')) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** Whether src[a..b) holds only spaces and tabs (empty counts as blank). */
function isBlankAt(src, a, b) {
  for (let i = a; i < b; i++) {
    const c = src[i];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}

/** [start, end) of src[a..b) with spaces and tabs dropped at either end. */
function trimAt(src, a, b) {
  while (a < b && (src[a] === ' ' || src[a] === '\t')) a++;
  while (b > a && (src[b - 1] === ' ' || src[b - 1] === '\t')) b--;
  return [a, b];
}

/** Whether the line src[a..b) ends a paragraph: blank, fence, heading or break. */
function endsParagraphAt(src, a, b) {
  if (a === b) return true;
  const c = src[a];
  if (c === ' ' || c === '\t') return isBlankAt(src, a, b);
  if (c === '`') return FENCE_OPEN.test(src.slice(a, b));
  if (c === '#') return headingOf(src.slice(a, b)) !== null;
  if (c === '-' || c === '*') return HR.test(src.slice(a, b));
  return false;
}

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/**
 * The first index from `from` where `s` holds `what` outside a backslash
 * escape, or -1. A match is escaped exactly when an odd number of
 * backslashes stands immediately before it: backslashes pair off left to
 * right, so an even run leaves the match bare and an odd run swallows its
 * first character. `from` is always a token boundary, so the run cannot
 * reach back past it.
 */
function findUnescaped(s, what, from) {
  let j = s.indexOf(what, from);
  while (j !== -1) {
    let k = j - 1;
    let bs = 0;
    while (k >= from && s[k] === '\\') {
      bs++;
      k--;
    }
    if (bs % 2 === 1) j = s.indexOf(what, j + 1);
    else return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  let j = s.indexOf('*', from);
  while (j !== -1) {
    // An escape is settled first, exactly as a left-to-right scan settles
    // it: a star the scan already swallowed as part of a `\*` pair is never
    // a candidate, and the star after it is seen fresh.
    let k = j - 1;
    let bs = 0;
    while (k >= from && s[k] === '\\') {
      bs++;
      k--;
    }
    if (bs % 2 === 1) {
      j = s.indexOf('*', j + 1);
      continue;
    }
    if (s[j + 1] === '*') {
      j = s.indexOf('*', j + 2);
      continue;
    }
    return j;
  }
  return -1;
}

/**
 * The next inline markup character in `s`, found by one regex scan instead
 * of a per-character JavaScript loop. Shared by every inline() call; each
 * branch below resets lastIndex after any nested inline() returns, so the
 * sharing is safe.
 */
const SPECIAL = /[\\`*\[]/g;

/**
 * `s` rendered inline into `out` (a shared array of strings, joined once by
 * the caller); `env.link(target)` is a link's href. Plain runs of text are
 * escaped in bulk instead of one regex call per character, which is where
 * the reference spends most of its time; only the markup itself is handled
 * singly. A failed strong, emphasis or link stays literal in the run: the
 * scan moves past its markers without flushing, exactly as the reference
 * leaves them in the text.
 */
function inline(s, env, out) {
  let runStart = 0;
  SPECIAL.lastIndex = 0;
  let m;
  while ((m = SPECIAL.exec(s)) !== null) {
    const p = m.index;
    const c = m[0];
    if (c === '\\') {
      const n = s[p + 1];
      if (n !== undefined && ESCAPABLE.has(n)) {
        if (p > runStart) out.push(escHtml(s.slice(runStart, p)));
        out.push(ESC[n] ?? n);
        runStart = p + 2;
        SPECIAL.lastIndex = runStart;
      } else {
        SPECIAL.lastIndex = p + 1;
      }
      continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', p + 1);
      if (j > p + 1) {
        if (p > runStart) out.push(escHtml(s.slice(runStart, p)));
        out.push('<code>', escHtml(s.slice(p + 1, j)), '</code>');
        runStart = j + 1;
        SPECIAL.lastIndex = runStart;
      } else {
        SPECIAL.lastIndex = p + 1;
      }
      continue;
    }
    if (c === '*') {
      if (s[p + 1] === '*') {
        const j = findUnescaped(s, '**', p + 2);
        if (j > p + 2) {
          if (p > runStart) out.push(escHtml(s.slice(runStart, p)));
          out.push('<strong>');
          inline(s.slice(p + 2, j), env, out);
          out.push('</strong>');
          runStart = j + 2;
          SPECIAL.lastIndex = runStart;
        } else {
          SPECIAL.lastIndex = p + 2;
        }
        continue;
      }
      const j = findSingleStar(s, p + 1);
      if (j > p + 1) {
        if (p > runStart) out.push(escHtml(s.slice(runStart, p)));
        out.push('<em>');
        inline(s.slice(p + 1, j), env, out);
        out.push('</em>');
        runStart = j + 1;
        SPECIAL.lastIndex = runStart;
      } else {
        SPECIAL.lastIndex = p + 1;
      }
      continue;
    }
    // '[': a link only when its text closes and its target is bare and nonempty.
    const k = findUnescaped(s, ']', p + 1);
    const q = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
    const target = q === -1 ? '' : s.slice(k + 2, q);
    if (target !== '' && !/\s/.test(target)) {
      if (p > runStart) out.push(escHtml(s.slice(runStart, p)));
      out.push('<a href="', escHtml(env.link(target)), '">');
      inline(s.slice(p + 1, k), env, out);
      out.push('</a>');
      runStart = q + 1;
      SPECIAL.lastIndex = runStart;
    } else {
      SPECIAL.lastIndex = p + 1;
    }
  }
  if (s.length > runStart) out.push(escHtml(s.slice(runStart)));
}

/**
 * `src` rendered in one pass over its lines (no token objects in between,
 * and no split of the body into lines: the walk yields each line exactly as
 * split('\n') would, as a [start, end) range): its HTML (each block on its
 * own lines, a "\n" after the last), its table of contents (every level 2
 * and 3 heading: level, id and its inline HTML) and its excerpt (the first
 * paragraph's inline HTML, or ""). Each line is classified by its first
 * character before any regex runs, so a prose line costs no regex at all.
 */
function renderMarkdown(src, env, slugify) {
  const blocks = [];
  const toc = [];
  const ids = new Set();
  let excerpt = null;
  const n = src.length;
  let pos = 0;
  while (pos <= n) {
    let e = src.indexOf('\n', pos);
    if (e === -1) e = n;
    const a = pos;
    const b = e;
    pos = e + 1;
    if (isBlankAt(src, a, b)) continue;
    const c0 = src[a];
    if (c0 === '`') {
      const fence = FENCE_OPEN.exec(src.slice(a, b));
      if (fence !== null) {
        const bodyStart = pos;
        let bodyEnd = -1;
        while (pos <= n) {
          let e2 = src.indexOf('\n', pos);
          if (e2 === -1) e2 = n;
          if (FENCE_CLOSE.test(src.slice(pos, e2))) {
            pos = e2 + 1;
            break;
          }
          bodyEnd = e2;
          pos = e2 + 1;
          if (e2 === n) {
            pos = n + 1;
            break;
          }
        }
        const body = bodyEnd === -1 ? '' : src.slice(bodyStart, bodyEnd);
        const cls = fence[1] === '' ? '' : ` class="language-${escHtml(fence[1])}"`;
        blocks.push(`<pre><code${cls}>${body === '' ? '' : `${escHtml(body)}\n`}</code></pre>`);
        continue;
      }
    }
    if (c0 === '#') {
      const heading = headingOf(src.slice(a, b));
      if (heading !== null) {
        const id = uniqueSlug(slugify(heading.text), ids);
        const o = [];
        inline(heading.text, env, o);
        const html = o.join('');
        blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>`);
        if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
        continue;
      }
    }
    if (c0 === '-' || c0 === '*') {
      if (HR.test(src.slice(a, b))) {
        blocks.push('<hr>');
        continue;
      }
    }
    if (c0 === '>') {
      const parts = [];
      let la = a;
      let lb = b;
      for (;;) {
        let s = la + 1;
        if (s < lb && src[s] === ' ') s++;
        const t = trimAt(src, s, lb);
        if (t[0] < t[1]) parts.push(src.slice(t[0], t[1]));
        if (lb === n) {
          pos = n + 1;
          break;
        }
        const na = lb + 1;
        if (na > n || src[na] !== '>') {
          pos = na;
          break;
        }
        let ne = src.indexOf('\n', na);
        if (ne === -1) ne = n;
        la = na;
        lb = ne;
      }
      if (parts.length === 0) {
        blocks.push('<blockquote>\n</blockquote>');
      } else {
        const o = [];
        inline(parts.join('\n'), env, o);
        blocks.push(`<blockquote>\n<p>${o.join('')}</p>\n</blockquote>`);
      }
      continue;
    }
    if (c0 === '-' || c0 === '*' || (c0 >= '0' && c0 <= '9')) {
      const lineStr = src.slice(a, b);
      const bullet = (c0 === '-' || c0 === '*') ? BULLET.exec(lineStr) : null;
      const ordered = bullet === null ? ORDERED.exec(lineStr) : null;
      if (bullet !== null || ordered !== null) {
        const isOrdered = ordered !== null;
        const marker = isOrdered ? ORDERED : BULLET;
        const start = isOrdered ? Number(ordered[1]) : 1;
        const items = [[trimLine(isOrdered ? ordered[2] : bullet[1])]];
        while (pos <= n) {
          let e2 = src.indexOf('\n', pos);
          if (e2 === -1) e2 = n;
          const l2 = src.slice(pos, e2);
          const mm = marker.exec(l2);
          if (mm !== null) {
            items.push([trimLine(isOrdered ? mm[2] : mm[1])]);
            pos = e2 + 1;
          } else if (CONTINUED.test(l2)) {
            items[items.length - 1].push(trimLine(l2));
            pos = e2 + 1;
          } else break;
          if (e2 === n) {
            pos = n + 1;
            break;
          }
        }
        const tag = isOrdered ? 'ol' : 'ul';
        const open = isOrdered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
        const lis = [];
        for (const parts of items) {
          const o = [];
          inline(parts.join('\n'), env, o);
          lis.push(`<li>${o.join('')}</li>\n`);
        }
        blocks.push(`${open}\n${lis.join('')}</${tag}>`);
        continue;
      }
    }
    // A paragraph: its lines trimmed and joined with '\n'. When no line
    // needed trimming the lines are one slice of the source as they stand.
    const ranges = [];
    let t = trimAt(src, a, b);
    ranges.push([a, b, t[0], t[1]]);
    while (pos <= n) {
      let e2 = src.indexOf('\n', pos);
      if (e2 === -1) e2 = n;
      if (endsParagraphAt(src, pos, e2)) break;
      t = trimAt(src, pos, e2);
      ranges.push([pos, e2, t[0], t[1]]);
      pos = e2 + 1;
    }
    let text;
    let fast = true;
    for (const r of ranges) {
      if (r[0] !== r[2] || r[1] !== r[3]) {
        fast = false;
        break;
      }
    }
    if (fast) text = src.slice(ranges[0][0], ranges[ranges.length - 1][1]);
    else text = ranges.map((r) => src.slice(r[2], r[3])).join('\n');
    const o = [];
    inline(text, env, o);
    const html = o.join('');
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  return { html: blocks.map((x) => `${x}\n`).join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF = /^if (not )?(\S+)$/;
const INCLUDE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** One scope frame, reused across a loop's iterations: its `loop` record is mutated, never replaced. */
function newFrame() {
  return { vars: { loop: { index: 0, first: false, last: false, length: 0 } }, parent: null };
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') {
      // Literal text next to literal text is one node: a layout rendered a
      // thousand times walks a thousand fewer nodes for it.
      const last = body[body.length - 1];
      if (last !== undefined && last.kind === 'text') last.text += tok.text;
      else body.push({ kind: 'text', text: tok.text });
    } else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [], frame: newFrame(), busy: false };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * `nodes` rendered into `out` (an array of strings, joined once by the caller),
 * in the scope ({ vars, parent }). `ctx` holds the parsed templates, the HTML
 * escape and the include depth. A loop renders into its node's own frame,
 * mutated per item instead of a fresh scope object per item; a loop entered
 * again while it is already running (a template including itself) takes a
 * fresh frame, so the outer iteration is never disturbed.
 */
function renderNodes(nodes, scope, ctx, depth, out) {
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var':
        out.push(ctx.escape(textOf(lookup(scope, n.path))));
        break;
      case 'raw':
        out.push(textOf(lookup(scope, n.path)));
        break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, scope, ctx, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        let frame = n.frame;
        let fresh = false;
        if (n.busy) {
          frame = newFrame();
          fresh = true;
        } else n.busy = true;
        frame.parent = scope;
        const loop = frame.vars.loop;
        for (let k = 0; k < xs.length; k++) {
          frame.vars[n.name] = xs[k];
          loop.index = k + 1;
          loop.first = k === 0;
          loop.last = k === xs.length - 1;
          loop.length = xs.length;
          renderNodes(n.body, frame, ctx, depth, out);
        }
        if (!fresh) n.busy = false;
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) renderNodes(t, scope, ctx, depth + 1, out);
        break;
      }
    }
  }
}

/** `nodes` rendered to a string. */
function renderTemplate(nodes, scope, ctx) {
  const out = [];
  renderNodes(nodes, scope, ctx, 0, out);
  return out.join('');
}

// ---------------------------------------------------------------- the build

/** The top-level directories the generator writes itself, which no page's slug at the root may take. */
const RESERVED = ['posts', 'tags', 'page'];

/** The report file every build writes. */
const REPORT_FILE = 'build-report.txt';

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** One site's output tree: path -> text. Nothing is kept from one call to the next. */
export function run(input) {
  const slugify = makeSlugify();
  const longDate = makeLongDate();

  /** A page's link record as templates read it. */
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });

  /** A post's card, as lists show it. */
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: s.readingMinutes,
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });

  /** A page as its layout reads it: its card's fields, then its own. */
  const pageOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: s.readingMinutes,
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });

  // Templates, parsed in code-unit order of name; one that does not parse is
  // reported and left out, as if it were not there.
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }

  const base = input.site.base_url.replace(/\/+$/, '');

  // 1. The sources, in code-unit order of their paths, line ends made "\n".
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  // 2. Each source's front matter: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // 3. Each page's output directory and url: its slug made unique in its directory, in source order.
  const taken = new Map();
  const takenIn = (dir) => {
    if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
    return taken.get(dir);
  };
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files they name.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env, slugify);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    // Counted once per page here, not once per card and once per page.
    s.readingMinutes = Math.max(1, Math.ceil(wordsOf(s.body) / 200));
  }

  // 5. The posts, newest first and then by slug; each post's newer and older neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    return (s.data.tags ?? []).filter((name) => !seen.has(slugify(name)) && seen.add(slugify(name)));
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      if (!bySlug.has(slug)) bySlug.set(slug, { name, slug, url: `${base}/tags/${slug}/`, posts: [] });
      const tag = bySlug.get(slug);
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) if (!s.post) s.tagRefs = ownTags(s).map((name) => bySlug.get(slugify(name)) ?? { name, slug: slugify(name), url: '', posts: [] });
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Every page through its layout, the index pages and the tag pages through theirs.
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  /** A tag as templates read it (its posts as cards). */
  const tagOf = (t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) });
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const ctx = { templates, escape: escHtml };
  const output = {};
  const render = (name, vars) => {
    const nodes = templates.get(name);
    return nodes === undefined ? null : renderTemplate(nodes, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, ctx);
  };
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const indexPages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= indexPages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: indexPages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === indexPages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: tagOf(t) });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}
