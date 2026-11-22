// main.ts is mend, the CLI SPEC.md specifies (MIT), built on the kit's starter. It does every section of SPEC.md:
// the command line, the output and exit codes, safe paths and format detection (sections 1 to 4), matching lines at
// three tiers (section 5), unified diffs (section 6), SEARCH/REPLACE blocks (section 7), V4A patches (section 8),
// JSON edits (section 9) and the all-or-nothing write (section 10). Nothing here reads a clock, a random number or a
// directory listing. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** The move edits that succeeded, as [old, new]. */
  moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

// ---------------------------------------------------------------------------------------------------------------
// Section 3: a file as lines.

interface Doc {
  lines: string[];
  br: string;
  final: boolean;
}

function toDoc(text: string): Doc {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text === '' ? [] : text.split(br);
  const final = text !== '' && text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function fromDoc(d: Doc): string {
  return d.lines.length === 0 ? '' : d.lines.join(d.br) + (d.final ? d.br : '');
}

// ---------------------------------------------------------------------------------------------------------------
// Section 5: matching lines at three tiers.

const rstrip = (s: string): string => s.replace(/[ \t]+$/, '');
const strip = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const indentOf = (s: string): string => /^[ \t]*/.exec(s)![0];
const TIERS: ((s: string) => string)[] = [(s) => s, rstrip, strip];

interface Found {
  tier: number;
  at: number[];
}

/** Every position >= from where `old` occurs in `lines`, at the first tier that has one; null when none has. */
function findOld(lines: string[], old: string[], strict: boolean, from = 0): Found | null {
  const k = old.length;
  const tiers = strict ? 1 : TIERS.length;
  for (let tier = 0; tier < tiers; tier += 1) {
    const norm = TIERS[tier]!;
    const want = old.map(norm);
    const have = tier === 0 ? lines : lines.map(norm);
    const at: number[] = [];
    for (let i = Math.max(0, from); i + k <= have.length; i += 1) {
      let same = true;
      for (let j = 0; j < k; j += 1) {
        if (have[i + j] !== want[j]) {
          same = false;
          break;
        }
      }
      if (same) at.push(i);
    }
    if (at.length > 0) return { tier, at };
  }
  return null;
}

/** A body line of a hunk or chunk: ' ' context, '-' old, '+' new. */
interface Item {
  kind: string;
  text: string;
}

const oldOf = (items: Item[]): string[] => items.filter((x) => x.kind !== '+').map((x) => x.text);

/** The lines that replace the match of `items`' old lines at position `at` of `lines`, found at `tier`. */
function newLines(lines: string[], items: Item[], at: number, tier: number): string[] {
  const old = oldOf(items);
  const F = old.length > 0 ? indentOf(lines[at]!) : '';
  const P = old.length > 0 ? indentOf(old[0]!) : '';
  const out: string[] = [];
  let j = 0;
  for (const it of items) {
    if (it.kind === ' ') {
      out.push(lines[at + j]!);
      j += 1;
    } else if (it.kind === '-') j += 1;
    else if (tier === 2 && it.text.trim() !== '' && it.text.startsWith(P)) out.push(F + it.text.slice(P.length));
    else out.push(it.text);
  }
  return out;
}

const spaces = (s: string): string => s.replace(/^ +/, '').replace(/ +$/, '');

function need(tree: Tree, p: string): string {
  const t = tree.get(p);
  if (t === null) throw new Fail('missing', p);
  return t;
}
function needNone(tree: Tree, p: string): void {
  if (tree.get(p) !== null) throw new Fail('exists', p);
}
function needSafe(p: string): void {
  if (!safe(p)) throw new Fail('unsafe', p);
}

// ---------------------------------------------------------------------------------------------------------------
// Section 6: unified diffs.

const NONE = '/dev/null';

interface Hunk {
  a: number;
  items: Item[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noEol: boolean;
  /** A `\` line follows the hunk's last `+` line (null: the hunk has no `+` line). */
  plusNoEol: boolean | null;
}

interface USection {
  git: [string, string] | null;
  pair: [string, string] | null;
  from: string | null;
  to: string | null;
  create: boolean;
  remove: boolean;
  hunks: Hunk[];
}

function pairPath(line: string): string {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = spaces(p);
  if (p === NONE) return p;
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}

function unifiedSections(lines: string[]): USection[] {
  const out: USection[] = [];
  let cur: USection | null = null;
  let header = false;
  const open = (): USection => {
    cur = { git: null, pair: null, from: null, to: null, create: false, remove: false, hunks: [] };
    out.push(cur);
    header = true;
    return cur;
  };
  const pairAt = (i: number): boolean => lines[i]!.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ');
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      open().git = [m[1]!, m[2]!];
      i += 1;
    } else if (l.startsWith('--- ')) {
      if (pairAt(i)) {
        // The pair belongs to the header of a `diff --git` section that has none yet; any other pair starts a section.
        const s: USection = cur !== null && header && cur.pair === null ? cur : open();
        s.pair = [pairPath(l), pairPath(lines[i + 1]!)];
        i += 2;
      } else {
        if (cur !== null && header) throw new Exit2(`error: parse ${i + 2}`);
        i += 1;
      }
    } else if (l.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(l);
      if (m === null || cur === null) throw new Exit2(`error: parse ${i + 1}`);
      header = false;
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const b = lines[j]!;
        if (b !== '' && !' -+\\'.includes(b[0]!)) break;
        if (pairAt(j)) break;
        body.push(b);
        j += 1;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      const raw: Item[] = body.map((b) => (b === '' ? { kind: ' ', text: '' } : { kind: b[0]!, text: b.slice(1) }));
      let lastNew = -1;
      let lastPlus = -1;
      raw.forEach((x, k) => {
        if (x.kind === ' ' || x.kind === '+') lastNew = k;
        if (x.kind === '+') lastPlus = k;
      });
      (cur as USection).hunks.push({
        a: Number(m[1]),
        items: raw.filter((x) => x.kind !== '\\'),
        noEol: lastNew >= 0 && raw[lastNew + 1]?.kind === '\\',
        plusNoEol: lastPlus < 0 ? null : raw[lastPlus + 1]?.kind === '\\',
      });
      i = j;
    } else {
      if (cur !== null && header) {
        const s: USection = cur;
        if (l.startsWith('rename from ')) s.from = spaces(l.slice(12));
        else if (l.startsWith('rename to ')) s.to = spaces(l.slice(10));
        else if (l.startsWith('new file mode')) s.create = true;
        else if (l.startsWith('deleted file mode')) s.remove = true;
      }
      i += 1;
    }
  }
  return out;
}

function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  const doc = toDoc(text);
  let d = 0;
  for (const h of hunks) {
    const old = oldOf(h.items);
    let at: number;
    let add: string[];
    if (old.length > 0) {
      const f = findOld(doc.lines, old, strict);
      if (f === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      at = f.at[0]!;
      for (const p of f.at) if (Math.abs(p - target) < Math.abs(at - target)) at = p;
      add = newLines(doc.lines, h.items, at, f.tier);
    } else {
      at = Math.max(0, Math.min(h.a + d, doc.lines.length));
      add = h.items.map((x) => x.text);
    }
    if (at + old.length === doc.lines.length) doc.final = !h.noEol;
    doc.lines.splice(at, old.length, ...add);
    d += add.length - old.length;
  }
  return fromDoc(doc);
}

function unifiedEdit(s: USection, strict: boolean): Edit {
  const oldPath = s.pair !== null ? s.pair[0] : (s.from ?? s.git![0]);
  const newPath = s.pair !== null ? s.pair[1] : (s.to ?? s.git![1]);
  return (tree) => {
    const creation = oldPath === NONE || s.create;
    const deletion = !creation && (newPath === NONE || s.remove);
    if (oldPath !== NONE) needSafe(oldPath);
    if (newPath !== NONE || creation) needSafe(newPath);
    if (creation) {
      needNone(tree, newPath);
      const add: string[] = [];
      let noEol = false;
      for (const h of s.hunks) {
        for (const x of h.items) if (x.kind === '+') add.push(x.text);
        if (h.plusNoEol !== null) noEol = h.plusNoEol;
      }
      tree.now.set(newPath, add.length === 0 ? '' : add.join('\n') + (noEol ? '' : '\n'));
    } else if (deletion) {
      need(tree, oldPath);
      tree.now.set(oldPath, null);
    } else if (oldPath !== newPath) {
      const before = need(tree, oldPath);
      needNone(tree, newPath);
      const after = applyHunks(before, s.hunks, strict, oldPath);
      tree.now.set(oldPath, null);
      tree.now.set(newPath, after);
      tree.moves.push([oldPath, newPath]);
    } else {
      const before = need(tree, oldPath);
      tree.now.set(oldPath, applyHunks(before, s.hunks, strict, oldPath));
    }
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  return unifiedSections(lines).map((s) => unifiedEdit(s, strict));
}

// ---------------------------------------------------------------------------------------------------------------
// Section 7: SEARCH/REPLACE blocks.

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  const marks = lines.map((l) => l.trimEnd());
  let prev: string | null = null;
  let floor = 0; // the first line after the previous block
  let i = 0;
  while (i < lines.length) {
    if (marks[i] !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const mid = marks.indexOf('=======', i + 1);
    const end = mid < 0 ? -1 : marks.indexOf('>>>>>>> REPLACE', mid + 1);
    if (end < 0) throw new Exit2(`error: parse ${i + 1}`);
    let path: string | null = null;
    for (let j = i - 1; j >= floor; j -= 1) {
      const t = lines[j]!.trim();
      if (t !== '' && !t.startsWith('```')) {
        path = t;
        break;
      }
    }
    if (path === null) path = prev;
    if (path === null) throw new Exit2(`error: parse ${i + 1}`);
    const p: string = path;
    const old = lines.slice(i + 1, mid);
    const items: Item[] = lines.slice(mid + 1, end).map((text) => ({ kind: '+', text }));
    edits.push((tree) => {
      needSafe(p);
      if (old.length === 0) {
        needNone(tree, p);
        tree.now.set(p, items.length === 0 ? '' : items.map((x) => `${x.text}\n`).join(''));
        return;
      }
      const doc = toDoc(need(tree, p));
      const f = findOld(doc.lines, old, strict);
      if (f === null) throw new Fail('no-match', p);
      if (f.at.length > 1) throw new Fail('ambiguous', p);
      const at = f.at[0]!;
      const all: Item[] = [...old.map((text) => ({ kind: '-', text })), ...items];
      doc.lines.splice(at, old.length, ...newLines(doc.lines, all, at, f.tier));
      tree.now.set(p, fromDoc(doc));
    });
    prev = p;
    floor = end + 1;
    i = end + 1;
  }
  return edits;
}

// ---------------------------------------------------------------------------------------------------------------
// Section 8: V4A patches.

interface Chunk {
  anchor: string | null;
  items: Item[];
  eof: boolean;
}

const V4A_STARTS = ['*** Add File: ', '*** Delete File: ', '*** Update File: '];

function v4aUpdate(path: string, move: string | null, chunks: Chunk[], strict: boolean): Edit {
  return (tree) => {
    needSafe(path);
    if (move !== null) needSafe(move);
    const doc = toDoc(need(tree, path));
    if (move !== null) needNone(tree, move);
    let cursor = 0;
    for (const c of chunks) {
      if (c.anchor !== null) {
        const a = findOld(doc.lines, [c.anchor], strict, cursor);
        if (a === null) throw new Fail('no-match', path);
        cursor = a.at[0]! + 1;
      }
      const old = oldOf(c.items);
      let at: number;
      let add: string[];
      if (old.length > 0) {
        const f = findOld(doc.lines, old, strict, c.eof ? Math.max(cursor, doc.lines.length - old.length) : cursor);
        if (f === null) throw new Fail('no-match', path);
        at = f.at[0]!;
        add = newLines(doc.lines, c.items, at, f.tier);
      } else {
        at = c.eof ? doc.lines.length : cursor;
        add = c.items.map((x) => x.text);
      }
      doc.lines.splice(at, old.length, ...add);
      cursor = at + add.length;
    }
    const after = fromDoc(doc);
    if (move === null) tree.now.set(path, after);
    else {
      tree.now.set(path, null);
      tree.now.set(move, after);
      tree.moves.push([path, move]);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (blank(lines[last]!)) last -= 1;
  if (last === first || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  const bad = (i: number): Exit2 => new Exit2(`error: parse ${i + 1}`);
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    const kind = V4A_STARTS.findIndex((s) => l.startsWith(s));
    if (kind < 0) {
      if (!blank(l)) throw bad(i);
      i += 1;
      continue;
    }
    const path = spaces(l.slice(V4A_STARTS[kind]!.length));
    const head = i;
    // The section's lines: up to the next section or `*** End Patch`, without the blank lines at its end.
    let next = i + 1;
    while (next < last && !V4A_STARTS.some((s) => lines[next]!.startsWith(s))) next += 1;
    let stop = next;
    while (stop > head + 1 && blank(lines[stop - 1]!)) stop -= 1;
    if (kind === 0) {
      const add: string[] = [];
      for (let j = head + 1; j < stop; j += 1) {
        const b = lines[j]!;
        if (b === '') add.push('');
        else if (b.startsWith('+')) add.push(b.slice(1));
        else throw bad(j);
      }
      edits.push((tree) => {
        needSafe(path);
        needNone(tree, path);
        tree.now.set(path, add.map((x) => `${x}\n`).join(''));
      });
    } else if (kind === 1) {
      if (stop > head + 1) throw bad(lines.findIndex((x, j) => j > head && !blank(x)));
      edits.push((tree) => {
        needSafe(path);
        need(tree, path);
        tree.now.set(path, null);
      });
    } else {
      let j = head + 1;
      let move: string | null = null;
      if (j < stop && lines[j]!.startsWith('*** Move to: ')) {
        move = spaces(lines[j]!.slice(13));
        j += 1;
      }
      const chunks: Chunk[] = [];
      let cur: Chunk | null = null;
      for (; j < stop; j += 1) {
        const b = lines[j]!;
        if (b.startsWith('@@')) {
          const anchor = spaces(b.slice(2));
          cur = { anchor: anchor === '' ? null : anchor, items: [], eof: false };
          chunks.push(cur);
        } else if (b === '*** End of File') {
          if (cur === null) throw bad(j);
          cur.eof = true;
          cur = null;
        } else if (b === '' || ' -+'.includes(b[0]!)) {
          if (cur === null) {
            if (chunks.length > 0) throw bad(j);
            cur = { anchor: null, items: [], eof: false };
            chunks.push(cur);
          }
          cur.items.push(b === '' ? { kind: ' ', text: '' } : { kind: b[0]!, text: b.slice(1) });
        } else throw bad(j);
      }
      if (chunks.length === 0 && move === null) throw bad(head);
      edits.push(v4aUpdate(path, move, chunks, strict));
    }
    i = next;
  }
  return edits;
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const moved = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = moved;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // A move whose old path is gone and whose new path is new is one `R` line, in place of its `D` and `A` lines.
  const renamedFrom = new Set<string>();
  const renamedTo = new Map<string, string>();
  for (const [from, to] of tree.moves) {
    if (renamedFrom.has(from) || renamedTo.has(to)) continue;
    if (tree.original(from) !== null && tree.get(from) === null && tree.original(to) === null && tree.get(to) !== null) {
      renamedFrom.add(from);
      renamedTo.set(to, from);
    }
  }
  const rows: string[] = [];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (renamedTo.has(p)) rows.push(`R ${renamedTo.get(p)!} -> ${p}`);
    else if (!renamedFrom.has(p)) rows.push(`${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`);
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
