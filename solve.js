// site-generator-fast-dropin: a faster drop-in for makefun-site 1.0.0.
// Byte-identical output, built by a single-pass fused renderer:
//  - front matter scanned with indexOf (no whole-body split)
//  - Markdown lexed and rendered in one pass over the lines, inline markup
//    rendered over string ranges with bulk HTML escaping (no per-char calls,
//    no token objects, no repeated slicing)
//  - table-driven escape, memoised slugify/longDate per build
//  - templates parsed once and rendered into one output array (no per-node
//    string concatenation, includes render into the same array)
//
// Everything below reproduces makefun-site 1.0.0's rules exactly; the
// reference is program/generator/vendor/makefun-site/ in the kit.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;
function escapeHtml(text) {
  return text.replace(ESC_RE, (c) => ESCAPES[c]);
}

const SLUG_MAX = 64;
function slugify(text) {
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
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function longDate(date) {
  const [y, m, d] = date.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const RESERVED = ['posts', 'tags', 'page'];

// ---------------------------------------------------------------- front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const LINE = /^([a-z_]+):(?: (.*))?$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME_RE = /^[a-z0-9-]+$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG_RE = /^[^"[\]]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = null;
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        if (out === null) out = raw.slice(1, i);
        out += n;
        i++;
      } else if (c === '"') {
        return { error: 'a quoted string holds a stray quote' };
      } else if (out !== null) {
        out += c;
      }
    }
    return { value: out === null ? raw.slice(1, -1) : out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE_RE.exec(raw);
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
      if (tags.some((t) => t === '' || !TAG_RE.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME_RE.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG_RE.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// Parse front matter without splitting the whole body: the body is the text
// after the closing --- line, sliced out directly.
function parseFrontMatter(text) {
  const firstNl = text.indexOf('\n');
  const first = firstNl === -1 ? text : text.slice(0, firstNl);
  if (first !== '---') return { error: 'no front matter' };
  // Find the closing --- line: scan line starts.
  let pos = firstNl === -1 ? text.length : firstNl + 1;
  let lineNo = 1; // 0-based index of the line starting at pos
  let closeLine = -1;
  let closeEnd = -1; // index of the \n ending the closing line, or text.length
  while (pos <= text.length) {
    const e = text.indexOf('\n', pos);
    const end = e === -1 ? text.length : e;
    if (end - pos === 3 && text.charCodeAt(pos) === 45 && text.charCodeAt(pos + 1) === 45 && text.charCodeAt(pos + 2) === 45) {
      closeLine = lineNo;
      closeEnd = end;
      break;
    }
    if (e === -1) break;
    pos = e + 1;
    lineNo++;
  }
  if (closeLine === -1) return { error: 'the front matter is not closed' };
  const data = {};
  // Walk the front-matter lines (1 .. closeLine-1).
  pos = firstNl === -1 ? text.length : firstNl + 1;
  for (let i = 1; i < closeLine; i++) {
    const e = text.indexOf('\n', pos);
    const end = e === -1 ? text.length : e;
    const line = text.slice(pos, end);
    pos = e === -1 ? text.length + 1 : e + 1;
    if (isBlankLine(line) || line.charCodeAt(0) === 35) continue;
    const m = LINE.exec(line);
    if (!m) return { error: `line ${i + 1} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  const body = closeEnd === text.length ? '' : text.slice(closeEnd + 1);
  return { data, body };
}

// ---------------------------------------------------------------- Markdown

const BLANK_RE = /^[ \t]*$/;
const FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const FENCE_CLOSE = /^```[ \t]*$/;
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const HR = /^(?:---|\*\*\*)[ \t]*$/;
const BULLET = /^[-*] (.*)$/;
const ORDERED = /^(\d{1,9})\. (.*)$/;
const CONTINUED = /^ {2,}\S/;
const TRIM = /^[ \t]+|[ \t]+$/g;

const trimLine = (line) => {
  const a = line.charCodeAt(0);
  const b = line.charCodeAt(line.length - 1);
  if (a !== 32 && a !== 9 && b !== 32 && b !== 9) return line;
  return line.replace(TRIM, '');
};

function headingOf(line) {
  const m = HEADING.exec(line);
  return m === null || m[2] === '' ? null : { depth: m[1].length, text: m[2] };
}

// Whether `line` ends a paragraph: a blank line, a fence, a heading or a
// thematic break. Dispatched on the first character (only those lines can
// match any of the four).
function endsParagraph(line) {
  const c = line.charCodeAt(0);
  if (line.length === 0) return true;
  if (c === 32 || c === 9) return BLANK_RE.test(line);
  if (c === 96) return FENCE_OPEN.test(line);
  if (c === 35) return headingOf(line) !== null;
  if (c === 45 || c === 42) return HR.test(line);
  return false;
}

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
const INLINE_SPECIAL = /[\\`*\[&<>"']/g;

function findUnescaped(s, what, from, hi) {
  for (let j = from; j <= hi - what.length; j++) {
    if (s[j] === '\\' && j + 1 < hi && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

function findSingleStar(s, from, hi) {
  for (let j = from; j < hi; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < hi && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (j + 1 < hi && s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

// Inline markup over s[lo..hi), appended to out. A single native regex scan
// finds the next character needing attention; the plain text between two
// such characters holds no escapable character, so it is pushed raw with no
// escapeHtml call and no per-character loop.
function inlineInto(s, lo, hi, env, out, re) {
  re.lastIndex = lo;
  let plain = lo;
  for (;;) {
    const m = re.exec(s);
    if (m === null || m.index >= hi) break;
    const i = m.index;
    const c = m[0];
    if (c === '&' || c === '<' || c === '>' || c === '"' || c === "'") {
      if (i > plain) out.push(s.slice(plain, i));
      out.push(ESCAPES[c]);
      plain = i + 1;
      re.lastIndex = i + 1;
      continue;
    }
    if (c === '\\') {
      if (i + 1 < hi && ESCAPABLE.has(s[i + 1])) {
        if (i > plain) out.push(s.slice(plain, i));
        const e = s[i + 1];
        out.push(ESCAPES[e] ?? e);
        plain = i + 2;
        re.lastIndex = i + 2;
      } else {
        re.lastIndex = i + 1;
      }
      continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j !== -1 && j < hi && j > i + 1) {
        if (i > plain) out.push(s.slice(plain, i));
        out.push('<code>', escapeHtml(s.slice(i + 1, j)), '</code>');
        plain = j + 1;
        re.lastIndex = j + 1;
      } else {
        re.lastIndex = i + 1;
      }
      continue;
    }
    if (c === '*') {
      if (i + 1 < hi && s[i + 1] === '*') {
        const j = findUnescaped(s, '**', i + 2, hi);
        if (j !== -1 && j > i + 2) {
          if (i > plain) out.push(s.slice(plain, i));
          out.push('<strong>');
          inlineInto(s, i + 2, j, env, out, re);
          out.push('</strong>');
          plain = j + 2;
          re.lastIndex = j + 2;
        } else {
          re.lastIndex = i + 2;
        }
        continue;
      }
      const j = findSingleStar(s, i + 1, hi);
      if (j !== -1 && j > i + 1) {
        if (i > plain) out.push(s.slice(plain, i));
        out.push('<em>');
        inlineInto(s, i + 1, j, env, out, re);
        out.push('</em>');
        plain = j + 1;
        re.lastIndex = j + 1;
      } else {
        re.lastIndex = i + 1;
      }
      continue;
    }
    // c === '['
    const k = findUnescaped(s, ']', i + 1, hi);
    let mm = -1;
    if (k !== -1 && k + 1 < hi && s[k + 1] === '(') {
      const t = s.indexOf(')', k + 2);
      if (t !== -1 && t < hi) mm = t;
    }
    if (mm !== -1) {
      const target = s.slice(k + 2, mm);
      if (target !== '' && !/\s/.test(target)) {
        if (i > plain) out.push(s.slice(plain, i));
        out.push('<a href="', escapeHtml(env.link(target)), '">');
        inlineInto(s, i + 1, k, env, out, re);
        out.push('</a>');
        plain = mm + 1;
        re.lastIndex = mm + 1;
        continue;
      }
    }
    re.lastIndex = i + 1;
  }
  if (hi > plain) out.push(s.slice(plain, hi));
}

function inlineStr(s, env) {
  const out = [];
  inlineInto(s, 0, s.length, env, out, INLINE_SPECIAL);
  return out.join('');
}

// Render one body: single pass over its lines, blocks rendered straight
// into the output array. Lines are walked with indexOf (no split, no
// per-line array); each line is classified by its first character, so the
// common paragraph line runs no regex at all. Returns { html, toc, excerpt }.
function renderMarkdown(src, env, ctx) {
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  const n = src.length;
  let pos = 0;
  while (pos <= n) {
    const e = src.indexOf('\n', pos);
    const end = e === -1 ? n : e;
    const line = src.slice(pos, end);
    const next = e === -1 ? n + 1 : e + 1;
    const c0 = line.charCodeAt(0);
    if (line.length === 0) {
      pos = next;
      continue;
    }
    if (c0 === 32 || c0 === 9) {
      // Blank, or a paragraph line (indented lines are never blocks).
      if (BLANK_RE.test(line)) {
        pos = next;
        continue;
      }
    } else if (c0 === 96) {
      const fence = FENCE_OPEN.exec(line);
      if (fence !== null) {
        const bodyStart = next;
        let p = bodyStart;
        let closed = false;
        let closeStart = -1;
        let closeNext = n + 1;
        while (p <= n) {
          const e2 = src.indexOf('\n', p);
          const end2 = e2 === -1 ? n : e2;
          if (src.charCodeAt(p) === 96 && src.charCodeAt(p + 1) === 96 && src.charCodeAt(p + 2) === 96 && FENCE_CLOSE.test(src.slice(p, end2))) {
            closed = true;
            closeStart = p;
            closeNext = e2 === -1 ? n + 1 : e2 + 1;
            break;
          }
          p = e2 === -1 ? n + 1 : e2 + 1;
        }
        const raw = closed ? src.slice(bodyStart, closeStart) : src.slice(bodyStart);
        const cls = fence[1] === '' ? '' : ` class="language-${escapeHtml(fence[1])}"`;
        blocks.push(`<pre><code${cls}>${escapeHtml(raw)}${closed ? '' : '\n'}</code></pre>`);
        pos = closed ? closeNext : n + 1;
        continue;
      }
    } else if (c0 === 35) {
      const heading = headingOf(line);
      if (heading !== null) {
        const id = uniqueSlug(ctx.slug(heading.text), ids);
        const html = inlineStr(heading.text, env);
        blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>`);
        if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
        pos = next;
        continue;
      }
    } else if (c0 === 45 || c0 === 42) {
      if (HR.test(line)) {
        blocks.push('<hr>');
        pos = next;
        continue;
      }
      const bullet = BULLET.exec(line);
      if (bullet !== null) {
        const items = [];
        let p = pos;
        while (p <= n) {
          const e2 = src.indexOf('\n', p);
          const end2 = e2 === -1 ? n : e2;
          const l2 = src.slice(p, end2);
          const m = BULLET.exec(l2);
          if (m !== null) {
            items.push([trimLine(m[1])]);
            p = e2 === -1 ? n + 1 : e2 + 1;
          } else if (CONTINUED.test(l2)) {
            items[items.length - 1].push(trimLine(l2));
            p = e2 === -1 ? n + 1 : e2 + 1;
          } else break;
        }
        let html = '<ul>\n';
        for (const item of items) html += `<li>${inlineStr(item.join('\n'), env)}</li>\n`;
        html += '</ul>';
        blocks.push(html);
        pos = p;
        continue;
      }
    } else if (c0 === 62) {
      const qlines = [];
      let p = pos;
      while (p <= n) {
        const e2 = src.indexOf('\n', p);
        const end2 = e2 === -1 ? n : e2;
        const l2 = src.slice(p, end2);
        if (l2.charCodeAt(0) !== 62) break;
        qlines.push(l2.replace(/^> ?/, ''));
        p = e2 === -1 ? n + 1 : e2 + 1;
      }
      const inner = qlines.map(trimLine).filter((l) => l !== '');
      blocks.push(inner.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inlineStr(inner.join('\n'), env)}</p>\n</blockquote>`);
      pos = p;
      continue;
    } else if (c0 >= 48 && c0 <= 57) {
      const ordered = ORDERED.exec(line);
      if (ordered !== null) {
        const start = Number(ordered[1]);
        const items = [];
        let p = pos;
        while (p <= n) {
          const e2 = src.indexOf('\n', p);
          const end2 = e2 === -1 ? n : e2;
          const l2 = src.slice(p, end2);
          const m = ORDERED.exec(l2);
          if (m !== null) {
            items.push([trimLine(m[2])]);
            p = e2 === -1 ? n + 1 : e2 + 1;
          } else if (CONTINUED.test(l2)) {
            items[items.length - 1].push(trimLine(l2));
            p = e2 === -1 ? n + 1 : e2 + 1;
          } else break;
        }
        let html = start !== 1 ? `<ol start="${start}">\n` : '<ol>\n';
        for (const item of items) html += `<li>${inlineStr(item.join('\n'), env)}</li>\n`;
        html += '</ol>';
        blocks.push(html);
        pos = p;
        continue;
      }
    }
    // Paragraph: this line and the lines after it up to a blank line, a
    // fence, a heading or a thematic break.
    const plines = [trimLine(line)];
    pos = next;
    while (pos <= n) {
      const e2 = src.indexOf('\n', pos);
      const end2 = e2 === -1 ? n : e2;
      const l2 = src.slice(pos, end2);
      if (endsParagraph(l2)) break;
      plines.push(trimLine(l2));
      pos = e2 === -1 ? n + 1 : e2 + 1;
    }
    const html = inlineStr(plines.join('\n'), env);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  return { html: blocks.map((b) => `${b}\n`).join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

const INCLUDE_DEPTH = 8;
const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

class TemplateError extends Error {}

function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

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

function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
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
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

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

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

// Render into out (one array per page); includes share the same array.
function renderNodes(nodes, scope, ctx, depth, out) {
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var': {
        const v = lookup(scope, n.path);
        out.push(typeof v === 'string' ? escapeHtml(v) : escapeHtml(textOf(v)));
        break;
      }
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
        const len = xs.length;
        for (let k = 0; k < len; k++) {
          const vars = { [n.name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === len - 1, length: len } };
          renderNodes(n.body, { vars, parent: scope }, ctx, depth, out);
        }
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

// ---------------------------------------------------------------- build

function isWS(code) {
  if (code <= 32) return code === 9 || code === 10 || code === 11 || code === 12 || code === 13 || code === 32;
  return code === 0xA0 || code === 0x1680 || (code >= 0x2000 && code <= 0x200A) || code === 0x2028 || code === 0x2029 || code === 0x202F || code === 0x205F || code === 0x3000 || code === 0xFEFF;
}

// Words: runs of non-whitespace, counted without building a match array.
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    if (isWS(text.charCodeAt(i))) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

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

/** One site's output tree: path -> text. */
export function run(input) {
  const output = {};
  const report = [];
  const templates = new Map();
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');

  // Per-build memoised helpers (never shared between cases).
  const slugCache = new Map();
  const slug = (text) => {
    let v = slugCache.get(text);
    if (v === undefined) {
      v = slugify(text);
      slugCache.set(text, v);
    }
    return v;
  };
  const dateCache = new Map();
  const dateLong = (date) => {
    let v = dateCache.get(date);
    if (v === undefined) {
      v = longDate(date);
      dateCache.set(date, v);
    }
    return v;
  };
  const ctx = { templates, slug, dateLong };

  // 1. Sources, sorted by path; .md sources have \r\n? made \n.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  let sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  // 2. Front matter, in source order; checks run in the reference's order.
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
  sources = kept;

  // 3. Permalinks: slug unique in its directory, in source order.
  const taken = new Map();
  const takenIn = (dir) => {
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    return set;
  };
  const bySource = new Map();
  for (const s of sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    s.slug = uniqueSlug(s.data.slug ?? slug(s.data.title), takenIn(dir));
    s.outDir = dir === '' ? s.slug : `${dir}/${s.slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Markdown, links resolved to pages and static files.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of sources) {
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
    const md = renderMarkdown(s.body, env, ctx);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. Collections: posts newest first, equal dates by slug.
  const posts = sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. Tags, grouped by slug, ordered by count then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const sl = slug(name);
      if (!seen.has(sl)) {
        seen.add(sl);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const sl = slug(name);
      let tag = bySlug.get(sl);
      if (tag === undefined) {
        tag = { name, slug: sl, url: `${base}/tags/${sl}/`, posts: [] };
        bySlug.set(sl, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of sources) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => {
        const sl = slug(name);
        return bySlug.get(sl) ?? { name, slug: sl, url: '', posts: [] };
      });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // Cards, pages, links — as templates read them.
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : dateLong(s.data.date) });
  const cardOf = (s) => {
    if (s._card === undefined) {
      s._card = {
        title: s.data.title,
        url: s.url,
        date: s.data.date ?? '',
        date_long: s.data.date === undefined ? '' : dateLong(s.data.date),
        summary: s.data.summary ?? '',
        excerpt: s.excerpt,
        reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
        tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
      };
    }
    return s._card;
  };
  const pageOf = (s) => ({
    ...cardOf(s),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });

  // 7. Layouts.
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cardOf(p));
  const tctx = { templates, escape: escapeHtml };
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    renderNodes(nodes, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, tctx, 0, out);
    return out.join('');
  };
  for (const s of sources) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cardOf(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cardOf(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = sources.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
