// @vitest-environment node

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ApprovedRoots,
  assertInsideApprovedRoot,
  isPathInsideRoot,
  realpathNearestExisting,
} from '../../src/main/pathSafety';

describe('isPathInsideRoot (posix)', () => {
  const p = path.posix;
  test('accepts root itself and descendants', () => {
    expect(isPathInsideRoot('/home/u/dl', '/home/u/dl', p)).toBe(true);
    expect(isPathInsideRoot('/home/u/dl/a/b.txt', '/home/u/dl', p)).toBe(true);
    expect(isPathInsideRoot('/home/u/dl/..foo', '/home/u/dl', p)).toBe(true);
  });
  test('rejects siblings, parents and prefix tricks', () => {
    expect(isPathInsideRoot('/home/u', '/home/u/dl', p)).toBe(false);
    expect(isPathInsideRoot('/home/u/dl2/x', '/home/u/dl', p)).toBe(false);
    expect(isPathInsideRoot('/etc/passwd', '/home/u/dl', p)).toBe(false);
  });
});

describe('isPathInsideRoot (win32)', () => {
  const w = path.win32;
  const root = 'C:\\Users\\me\\Downloads';
  test('accepts descendants, case-insensitively', () => {
    expect(isPathInsideRoot('C:\\Users\\me\\Downloads\\a\\b.txt', root, w)).toBe(true);
    expect(isPathInsideRoot('c:\\users\\ME\\downloads\\x', root, w)).toBe(true);
  });
  test('rejects backslash traversal from a pod file name', () => {
    const evil = w.resolve(root, 'dir', '..\\..\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\x.bat');
    expect(isPathInsideRoot(evil, root, w)).toBe(false);
    // Mixed separators as produced by the renderer's '/' join.
    const mixed = w.resolve(root + '/dir/..\\..\\..\\x.bat');
    expect(isPathInsideRoot(mixed, root, w)).toBe(false);
  });
  test('rejects other drives and UNC paths', () => {
    expect(isPathInsideRoot('D:\\Users\\me\\Downloads\\x', root, w)).toBe(false);
    expect(isPathInsideRoot('\\\\server\\share\\x', root, w)).toBe(false);
  });
  test('assertInsideApprovedRoot with win32 path impl', () => {
    const identity = (x: string) => x;
    expect(assertInsideApprovedRoot(root + '/sub/f.txt', root, identity, w)).toBe('C:\\Users\\me\\Downloads\\sub\\f.txt');
    expect(() => assertInsideApprovedRoot(root + '/sub/..\\..\\..\\evil.bat', root, identity, w)).toThrow(/outside/);
  });
});

describe('filesystem containment', () => {
  let tmp: string;
  let root: string;
  let outside: string;

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'truss-pathsafety-')));
    root = path.join(tmp, 'dest');
    outside = path.join(tmp, 'outside');
    fs.mkdirSync(root);
    fs.mkdirSync(outside);
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('allows new nested paths under the root', () => {
    const target = path.join(root, 'a', 'b', 'c.txt');
    expect(assertInsideApprovedRoot(target, root)).toBe(target);
    expect(realpathNearestExisting(target)).toBe(target);
  });

  test('rejects lexical traversal', () => {
    expect(() => assertInsideApprovedRoot(path.join(root, '..', 'outside', 'x'), root)).toThrow(/outside the destination/);
    expect(() => assertInsideApprovedRoot(root + '/a/../../outside/x', root)).toThrow(/outside the destination/);
  });

  test('rejects a symlink inside the root pointing outside', () => {
    fs.symlinkSync(outside, path.join(root, 'link'), 'dir');
    expect(() => assertInsideApprovedRoot(path.join(root, 'link', 'x.txt'), root)).toThrow(/resolves outside/);
    expect(() => assertInsideApprovedRoot(path.join(root, 'link', 'new', 'deep.txt'), root)).toThrow(/resolves outside/);
  });

  test('accepts a root that is itself a symlink', () => {
    const linkRoot = path.join(tmp, 'linkroot');
    fs.symlinkSync(root, linkRoot, 'dir');
    expect(() => assertInsideApprovedRoot(path.join(linkRoot, 'f.txt'), linkRoot)).not.toThrow();
  });

  test('rejects when no root approved or path is invalid', () => {
    expect(() => assertInsideApprovedRoot(path.join(root, 'x'), undefined)).toThrow(/no destination/);
    expect(() => assertInsideApprovedRoot('', root)).toThrow(/invalid path/);
    expect(() => assertInsideApprovedRoot(path.join(root, 'a\0b'), root)).toThrow(/invalid path/);
    expect(() => assertInsideApprovedRoot(42, root)).toThrow(/invalid path/);
  });
});

describe('ApprovedRoots', () => {
  test('tracks one root per owner and clears it', () => {
    const roots = new ApprovedRoots();
    expect(roots.get(1)).toBeUndefined();
    roots.approve(1, '/home/u/dl', path.posix);
    roots.approve(2, '/tmp/other', path.posix);
    expect(roots.get(1)).toBe('/home/u/dl');
    roots.approve(1, '/home/u/dl2/', path.posix);
    expect(roots.get(1)).toBe('/home/u/dl2');
    roots.clear(1);
    expect(roots.get(1)).toBeUndefined();
    expect(roots.get(2)).toBe('/tmp/other');
  });

  test('rejects relative or invalid roots', () => {
    const roots = new ApprovedRoots();
    expect(() => roots.approve(1, 'relative/dir', path.posix)).toThrow();
    expect(() => roots.approve(1, '', path.posix)).toThrow();
    expect(() => roots.approve(1, '/a\0b', path.posix)).toThrow();
  });
});
