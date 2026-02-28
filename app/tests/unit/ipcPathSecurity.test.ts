// @vitest-environment node
//
// Tests for the plugin path containment logic used by main.ts.
// Exercise the shared helper directly so tests stay aligned with production behavior.

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { readPluginFileUtf8 } from '../../src/main/pluginFs';

let tmpDir: string;
let pluginDir: string;
let outsideDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'truss-test-'));
  pluginDir = path.join(tmpDir, 'plugin');
  outsideDir = path.join(tmpDir, 'outside');
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('plugin-read-file path containment', () => {
  test('reads a legitimate file inside the plugin directory', () => {
    fs.writeFileSync(path.join(pluginDir, 'manifest.json'), '{"name":"test"}');
    const content = readPluginFileUtf8(pluginDir, 'manifest.json');
    expect(content).toBe('{"name":"test"}');
  });

  test('reads a file in a subdirectory', () => {
    const sub = path.join(pluginDir, 'assets');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, 'icon.svg'), '<svg/>');
    const content = readPluginFileUtf8(pluginDir, 'assets/icon.svg');
    expect(content).toBe('<svg/>');
  });

  test('blocks simple ../ traversal (lexical check)', () => {
    fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'secret');
    expect(() => readPluginFileUtf8(pluginDir, '../outside/secret.txt')).toThrow(/Path traversal denied/);
  });

  test('blocks absolute path outside plugin dir (lexical check)', () => {
    const target = path.join(outsideDir, 'secret.txt');
    fs.writeFileSync(target, 'secret');
    // path.resolve treats absolute relativePath as absolute, so lexical check fires.
    expect(() => readPluginFileUtf8(pluginDir, target)).toThrow(/Path traversal denied/);
  });

  test('blocks symlink pointing outside the plugin directory (symlink check)', () => {
    const secretFile = path.join(outsideDir, 'secret.txt');
    fs.writeFileSync(secretFile, 'escaped!');

    // Create a symlink inside pluginDir that points to the file outside.
    const symlinkPath = path.join(pluginDir, 'escape.txt');
    fs.symlinkSync(secretFile, symlinkPath);

    // The lexical check passes (escape.txt is inside pluginDir),
    // but the symlink-resolved check must block it.
    expect(() => readPluginFileUtf8(pluginDir, 'escape.txt')).toThrow(/Path traversal denied/);
  });

  test('blocks symlink-to-directory pointing outside the plugin directory', () => {
    const secretFile = path.join(outsideDir, 'secret.txt');
    fs.writeFileSync(secretFile, 'escaped via dir!');

    // Symlink to the outside directory from inside pluginDir.
    const dirLink = path.join(pluginDir, 'linked-dir');
    fs.symlinkSync(outsideDir, dirLink);

    // Reading through the symlinked directory must be blocked.
    expect(() => readPluginFileUtf8(pluginDir, 'linked-dir/secret.txt')).toThrow(/Path traversal denied/);
  });

  test('throws File not found for non-existent paths', () => {
    expect(() => readPluginFileUtf8(pluginDir, 'does-not-exist.txt')).toThrow(/File not found/);
  });

  test('allows a symlink inside the plugin directory pointing to another file inside it', () => {
    fs.writeFileSync(path.join(pluginDir, 'real.txt'), 'internal content');
    const symlinkPath = path.join(pluginDir, 'alias.txt');
    fs.symlinkSync(path.join(pluginDir, 'real.txt'), symlinkPath);

    const content = readPluginFileUtf8(pluginDir, 'alias.txt');
    expect(content).toBe('internal content');
  });
});
