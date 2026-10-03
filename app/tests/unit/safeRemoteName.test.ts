import { describe, test, expect } from 'vitest';
import { isSafeRemoteName } from '../../src/renderer/lib/safeRemoteName';

describe('isSafeRemoteName', () => {
  test.each([
    'file.txt',
    'README',
    '.bashrc',
    '..hidden',
    'a..b',
    'café.log',
    'console.log',
    'COM10',
    'my file.txt',
    'nul-thing',
  ])('accepts %j', (name) => {
    expect(isSafeRemoteName(name)).toBe(true);
  });

  test.each([
    '',
    '.',
    '..',
    'a/b',
    '../etc/passwd',
    '..\\..\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\x.bat',
    'evil\\x.bat',
    'nul\0byte',
    'line\nbreak',
    'tab\there',
    'bell\u0007',
    'del\u007f',
    'trailing.',
    'trailing ',
    '...',
    'C:evil',
    'file.txt:stream',
    'CON',
    'con',
    'PRN.txt',
    'aux.tar.gz',
    'NUL',
    'nul.log',
    'COM1',
    'com9.txt',
    'LPT1',
    'lpt9.dat',
  ])('rejects %j', (name) => {
    expect(isSafeRemoteName(name)).toBe(false);
  });

  test('rejects non-strings', () => {
    expect(isSafeRemoteName(undefined)).toBe(false);
    expect(isSafeRemoteName(null)).toBe(false);
    expect(isSafeRemoteName(42)).toBe(false);
  });
});
