// @vitest-environment node
//
// Tests for the navigation / IPC-sender URL policy used by src/main/security.ts.

import { describe, test, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { CONTENT_SECURITY_POLICY, isAppUrl, isExternalHttpUrl } from '../../src/main/urlPolicy';

const dev = { devServerUrl: 'http://localhost:5173/' };
const packaged = { indexFileUrl: 'file:///opt/Truss/resources/app.asar/dist/renderer/index.html' };

describe('isAppUrl (dev)', () => {
  test('allows the dev server root and session query/hash routes', () => {
    expect(isAppUrl('http://localhost:5173/', dev)).toBe(true);
    expect(isAppUrl('http://localhost:5173/?session=exec&pod=a', dev)).toBe(true);
    expect(isAppUrl('http://localhost:5173/#/settings', dev)).toBe(true);
  });

  test('rejects other origins and schemes', () => {
    expect(isAppUrl('http://localhost:5174/', dev)).toBe(false);
    expect(isAppUrl('https://localhost:5173/', dev)).toBe(false);
    expect(isAppUrl('http://evil.example/', dev)).toBe(false);
    expect(isAppUrl('file:///tmp/evil.html', dev)).toBe(false);
    expect(isAppUrl('javascript:alert(1)', dev)).toBe(false);
    expect(isAppUrl('data:text/html,<script>1</script>', dev)).toBe(false);
  });
});

describe('isAppUrl (packaged)', () => {
  test('allows index.html with query and hash changes', () => {
    expect(isAppUrl(packaged.indexFileUrl, packaged)).toBe(true);
    expect(isAppUrl(`${packaged.indexFileUrl}?session=logs&pod=x`, packaged)).toBe(true);
    expect(isAppUrl(`${packaged.indexFileUrl}?session=yaml-diff&token=t#frag`, packaged)).toBe(true);
  });

  test('rejects other file:// paths', () => {
    expect(isAppUrl('file:///tmp/evil.html', packaged)).toBe(false);
    expect(isAppUrl('file:///opt/Truss/resources/app.asar/dist/renderer/other.html', packaged)).toBe(false);
    expect(isAppUrl('file:///opt/Truss/resources/app.asar/dist/renderer/../renderer/x/../../evil.html', packaged)).toBe(false);
    expect(isAppUrl('file://remotehost/opt/Truss/resources/app.asar/dist/renderer/index.html', packaged)).toBe(false);
  });

  test('rejects http, javascript:, data:, garbage and empty', () => {
    expect(isAppUrl('http://localhost:5173/', packaged)).toBe(false);
    expect(isAppUrl('https://example.com/index.html', packaged)).toBe(false);
    expect(isAppUrl('javascript:alert(1)', packaged)).toBe(false);
    expect(isAppUrl('data:text/html,hi', packaged)).toBe(false);
    expect(isAppUrl('not a url', packaged)).toBe(false);
    expect(isAppUrl('', packaged)).toBe(false);
    expect(isAppUrl(undefined, packaged)).toBe(false);
  });

  test('handles percent-encoded paths and Windows drive-letter case', () => {
    const spaced = { indexFileUrl: 'file:///C:/Program%20Files/Truss/index.html' };
    expect(isAppUrl('file:///c:/Program%20Files/Truss/index.html?session=files', spaced)).toBe(true);
    expect(isAppUrl('file:///C:/Program Files/Truss/index.html', spaced)).toBe(true);
    expect(isAppUrl('file:///D:/Program%20Files/Truss/index.html', spaced)).toBe(false);
  });

  test('rejects everything when no spec is configured', () => {
    expect(isAppUrl(packaged.indexFileUrl, {})).toBe(false);
  });
});

describe('isExternalHttpUrl', () => {
  test('allows only http and https', () => {
    expect(isExternalHttpUrl('https://grafana.example/d/abc')).toBe(true);
    expect(isExternalHttpUrl('http://127.0.0.1:8080')).toBe(true);
    expect(isExternalHttpUrl('file:///etc/passwd')).toBe(false);
    expect(isExternalHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isExternalHttpUrl('data:text/html,hi')).toBe(false);
    expect(isExternalHttpUrl('smb://host/share')).toBe(false);
    expect(isExternalHttpUrl('')).toBe(false);
  });
});

describe('CONTENT_SECURITY_POLICY', () => {
  test('matches the meta tag in index.html', () => {
    const html = fs.readFileSync(path.resolve(__dirname, '../../index.html'), 'utf8');
    const match = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/);
    expect(match?.[1]).toBe(CONTENT_SECURITY_POLICY);
  });
});
