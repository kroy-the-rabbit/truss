// Containment checks for local filesystem writes requested by the renderer
// (pod -> local downloads). Main only writes inside a destination root that was
// explicitly approved for the requesting webContents.

import fs from 'fs';
import path from 'path';

type PathImpl = Pick<typeof path, 'resolve' | 'relative' | 'isAbsolute' | 'dirname' | 'basename' | 'join'>;
type RealpathFn = (p: string) => string;

const defaultRealpath: RealpathFn = (p) => fs.realpathSync.native(p);

/**
 * Pure lexical check: is `target` equal to or inside `root`?
 * Both should be absolute paths for `pathImpl`.
 */
export function isPathInsideRoot(target: string, root: string, pathImpl: PathImpl = path): boolean {
  const rel = pathImpl.relative(root, target);
  if (rel === '') return true;
  if (pathImpl.isAbsolute(rel)) return false; // different drive / UNC share
  const first = rel.split(/[\\/]/)[0];
  return first !== '..';
}

/**
 * Resolve `target` through symlinks as far as it exists: realpath the nearest
 * existing ancestor and re-append the not-yet-existing tail.
 */
export function realpathNearestExisting(
  target: string,
  realpath: RealpathFn = defaultRealpath,
  pathImpl: PathImpl = path,
): string {
  let current = pathImpl.resolve(target);
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpath(current);
      return tail.length ? pathImpl.join(real, ...[...tail].reverse()) : real;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw err;
      const parent = pathImpl.dirname(current);
      if (parent === current) throw err;
      tail.push(pathImpl.basename(current));
      current = parent;
    }
  }
}

/**
 * Resolve `target` and require it to be inside `root`, both lexically and
 * after symlink resolution of the nearest existing ancestor. Returns the
 * resolved target path on success; throws otherwise.
 */
export function assertInsideApprovedRoot(
  target: unknown,
  root: string | undefined,
  realpath: RealpathFn = defaultRealpath,
  pathImpl: PathImpl = path,
): string {
  if (!root) {
    throw new Error('Local write denied: no destination folder has been selected');
  }
  if (typeof target !== 'string' || target.length === 0 || target.includes('\0')) {
    throw new Error('Local write denied: invalid path');
  }
  const resolved = pathImpl.resolve(target);
  const resolvedRoot = pathImpl.resolve(root);
  if (!isPathInsideRoot(resolved, resolvedRoot, pathImpl)) {
    throw new Error(`Local write denied: ${resolved} is outside the destination folder ${resolvedRoot}`);
  }
  const realTarget = realpathNearestExisting(resolved, realpath, pathImpl);
  const realRoot = realpathNearestExisting(resolvedRoot, realpath, pathImpl);
  if (!isPathInsideRoot(realTarget, realRoot, pathImpl)) {
    throw new Error(`Local write denied: ${resolved} resolves outside the destination folder ${resolvedRoot}`);
  }
  return resolved;
}

/** Approved download destination root per webContents id (latest wins). */
export class ApprovedRoots {
  private roots = new Map<number, string>();

  approve(ownerId: number, root: string, pathImpl: PathImpl = path): string {
    if (typeof root !== 'string' || root.length === 0 || root.includes('\0') || !pathImpl.isAbsolute(root)) {
      throw new Error('Invalid destination folder');
    }
    const resolved = pathImpl.resolve(root);
    this.roots.set(ownerId, resolved);
    return resolved;
  }

  get(ownerId: number): string | undefined {
    return this.roots.get(ownerId);
  }

  clear(ownerId: number): void {
    this.roots.delete(ownerId);
  }
}
