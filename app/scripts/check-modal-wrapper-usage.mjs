import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = new URL('../src/renderer', import.meta.url).pathname;

const allowedFiles = new Set([
  'components/Modal.tsx',
]);

const bannedPatterns = [
  { re: /className="modal-overlay"/g, label: 'modal-overlay wrapper' },
  { re: /className="plugin-manager-overlay"/g, label: 'plugin-manager-overlay wrapper' },
];

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...walk(full));
      continue;
    }
    if (name.endsWith('.tsx')) out.push(full);
  }
  return out;
}

const violations = [];
for (const file of walk(root)) {
  const rel = relative(root, file).replaceAll('\\', '/');
  if (allowedFiles.has(rel)) continue;
  const text = readFileSync(file, 'utf8');
  for (const { re, label } of bannedPatterns) {
    if (re.test(text)) {
      violations.push({ rel, label });
      break;
    }
  }
}

if (violations.length > 0) {
  console.error('Modal wrapper usage check failed. Use `components/Modal.tsx` for renderer dialogs.');
  for (const v of violations) {
    console.error(`- ${v.rel}: ${v.label}`);
  }
  process.exit(1);
}

console.log('Modal wrapper usage check passed.');
