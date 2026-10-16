import { promises as fs, existsSync, readFileSync, statSync } from 'node:fs';
import { resolve, relative, isAbsolute, dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import ignore from 'ignore';

export const hash = text => createHash('sha256').update(text).digest('hex');
export const slash = path => path.replaceAll('\\', '/');
export const pathKey = path => process.platform === 'win32' ? slash(resolve(path)).toLowerCase() : resolve(path);
export const within = (root, target) => { const rel = relative(root, target); return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + (process.platform === 'win32' ? '\\' : '/'))); };
export function fail(code, message) { throw Object.assign(new Error(message), { code }); }
export async function safePath(root, input, allowMissing = false) {
  if (typeof input !== 'string' || !input || input.includes('\0')) fail('INVALID_PATH', 'Expected a nonempty project-relative file path.');
  const target = resolve(root, input);
  if (!within(root, target)) fail('OUTSIDE_WORKSPACE', 'Path must stay inside the active project.');
  let ancestor = target;
  while (true) {
    try { const canonical = await fs.realpath(ancestor); if (!within(root, canonical)) fail('OUTSIDE_WORKSPACE', 'Symlink target leaves the active project.'); break; }
    catch (error) { if (error.code !== 'ENOENT' || !allowMissing || ancestor === dirname(ancestor)) throw error; ancestor = dirname(ancestor); }
  }
  return target;
}

const SKIP = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', 'target', 'dist', 'build', '.serena', '.codex-ide-bridge']);
export async function scanFiles(root, { extensions, maxFiles = 5000 } = {}) {
  const files = []; let truncated = false;
  async function walk(directory, inherited, depth) {
    if (depth > 40 || truncated) return;
    let rules = inherited;
    try { rules = [...inherited, { base: directory, matcher: ignore().add(await fs.readFile(join(directory, '.gitignore'), 'utf8')) }]; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const entries = (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink() || SKIP.has(entry.name)) continue;
      const path = join(directory, entry.name);
      if (rules.some(rule => rule.matcher.ignores(slash(relative(rule.base, path)) + (entry.isDirectory() ? '/' : '')))) continue;
      if (entry.isDirectory()) await walk(path, rules, depth + 1);
      else if (entry.isFile() && (!extensions || extensions.some(ext => entry.name.endsWith(ext)))) {
        if (files.length >= maxFiles) { truncated = true; return; }
        files.push(path);
      }
    }
  }
  await walk(root, [], 0);
  return { files, truncated };
}
export async function readText(root, input) {
  const path = await safePath(root, input);
  const info = await fs.stat(path);
  if (!info.isFile() || info.size > 2 * 1024 * 1024) fail('FILE_TOO_LARGE', 'Expected a source file no larger than 2 MiB.');
  const text = await fs.readFile(path, 'utf8');
  if (text.includes('\0')) fail('BINARY_FILE', 'Binary files cannot be edited as source text.');
  return { path, text, hash: hash(text) };
}
export function positionAt(text, offset) {
  if (!Number.isInteger(offset) || offset < 0 || offset > text.length) fail('INVALID_POSITION', 'Source offset is out of range.');
  const previous = text.slice(0, offset), line = previous.split('\n').length - 1;
  return { line, character: offset - (previous.lastIndexOf('\n') + 1) };
}
export function offsetAt(text, position) {
  if (!Number.isInteger(position?.line) || !Number.isInteger(position?.character) || position.line < 0 || position.character < 0) fail('INVALID_POSITION', 'Positions use nonnegative, zero-based UTF-16 line/character values.');
  const lines = text.split('\n');
  if (position.line >= lines.length || position.character > lines[position.line].replace(/\r$/, '').length) fail('INVALID_POSITION', 'Position exceeds source line bounds.');
  let result = position.character;
  for (let i = 0; i < position.line; i++) result += lines[i].length + 1;
  return result;
}

async function atomicWrite(path, text) {
  const temp = path + '.codex-bridge-' + randomUUID() + '.tmp';
  try { const mode = (await fs.stat(path)).mode; await fs.writeFile(temp, text, { flag: 'wx', mode }); await fs.rename(temp, path); }
  finally { await fs.unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
export async function applyChanges(root, changes, { dryRun = true } = {}) {
  // Validate every file and every edit before the first write. Unsupported LSP
  // resource operations are rejected by the caller instead of partly applied.
  const plans = [];
  for (const [input, edits] of changes) {
    const snapshot = await readText(root, input);
    const normalized = edits.map(edit => ({ ...edit,
      start: typeof edit.start === 'number' ? edit.start : offsetAt(snapshot.text, edit.range.start),
      end: typeof edit.end === 'number' ? edit.end : offsetAt(snapshot.text, edit.range.end),
    })).sort((a, b) => b.start - a.start || b.end - a.end);
    let previous = snapshot.text.length + 1, next = snapshot.text;
    for (const edit of normalized) {
      if (edit.expectedHash && edit.expectedHash !== snapshot.hash) fail('STALE_DOCUMENT', 'Source changed since it was inspected: ' + input);
      if (edit.start < 0 || edit.end < edit.start || edit.end > snapshot.text.length || edit.end > previous) fail('INVALID_EDIT', 'Overlapping or invalid source edits: ' + input);
      previous = edit.start; next = next.slice(0, edit.start) + edit.newText + next.slice(edit.end);
    }
    plans.push({ ...snapshot, next, normalized, editCount: normalized.length, relative_path: slash(relative(root, snapshot.path)) });
  }
  let budget = 32000;
  const preview = plans.map(plan => {
    const changes = [];
    for (const edit of [...plan.normalized].reverse()) {
      if (budget <= 0 || changes.length >= 50) break;
      const oldText = plan.text.slice(edit.start, edit.end), limit = Math.min(2000, Math.floor(budget / 2));
      const old_text = oldText.slice(0, limit), new_text = edit.newText.slice(0, limit);
      budget -= old_text.length + new_text.length + 100;
      changes.push({ range: { start: positionAt(plan.text, edit.start), end: positionAt(plan.text, edit.end) }, old_text, new_text,
        truncated: old_text.length < oldText.length || new_text.length < edit.newText.length });
    }
    return { relative_path: plan.relative_path, edits: plan.editCount, before_hash: plan.hash, after_hash: hash(plan.next), changes,
      preview_truncated: changes.length !== plan.editCount || changes.some(change => change.truncated) };
  });
  if (dryRun) return { applied: false, dry_run: true, files: preview };
  for (const plan of plans) if ((await readText(root, plan.path)).hash !== plan.hash) fail('STALE_DOCUMENT', 'Source changed before apply: ' + plan.relative_path);
  const written = [];
  try {
    for (const plan of plans) {
      await safePath(root, plan.path);
      if ((await readText(root, plan.path)).hash !== plan.hash) fail('STALE_DOCUMENT', 'Source changed during apply: ' + plan.relative_path);
      await atomicWrite(plan.path, plan.next); written.push(plan);
    }
  } catch (error) {
    const conflicts = [];
    for (const plan of written.reverse()) {
      try { if ((await readText(root, plan.path)).hash !== hash(plan.next)) throw new Error('concurrent edit'); await atomicWrite(plan.path, plan.text); }
      catch { conflicts.push(plan.relative_path); }
    }
    if (conflicts.length) fail('PARTIAL_APPLY', 'Apply failed; concurrent edits prevented rollback in: ' + conflicts.join(', '));
    throw error;
  }
  return { applied: true, dry_run: false, files: preview };
}
