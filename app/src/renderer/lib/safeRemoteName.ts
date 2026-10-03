// Validation for file names that come from inside a container (e.g. `ls -la`
// output) before they are used to build a path on the local machine.
//
// Linux allows almost any byte in a file name, including `\`, which Windows
// treats as a path separator. A malicious pod could therefore create a file
// named `..\..\AppData\...\Startup\x.bat` and, without this check, a download
// on Windows would write outside the destination folder. We apply the strictest
// rules of any supported desktop platform so behavior is the same everywhere.

const WINDOWS_RESERVED = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export function isSafeRemoteName(name: unknown): boolean {
  if (typeof name !== 'string' || name.length === 0) return false;
  if (name === '.' || name === '..') return false;
  if (name.includes('/') || name.includes('\\')) return false;
  if (CONTROL_CHARS.test(name)) return false;
  // Windows silently strips trailing dots/spaces, which can turn a name into
  // `..` or make it collide with another entry.
  if (/[. ]$/.test(name)) return false;
  // `C:foo` is drive-relative on Windows; `:` also opens alternate data streams.
  if (name.includes(':')) return false;
  if (WINDOWS_RESERVED.test(name)) return false;
  return true;
}
