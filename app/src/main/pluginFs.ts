import fs from 'fs';
import path from 'path';

export function resolvePluginFilePath(pluginDir: string, relativePath: string): string {
  const filePath = path.resolve(pluginDir, relativePath);

  // Lexical containment check first to catch obvious traversals before filesystem access.
  if (!filePath.startsWith(pluginDir + path.sep) && filePath !== pluginDir) {
    throw new Error(`Path traversal denied: ${relativePath}`);
  }

  let realFilePath: string;
  let realPluginDir: string;
  try {
    realFilePath = fs.realpathSync(filePath);
    realPluginDir = fs.realpathSync(pluginDir);
  } catch {
    throw new Error(`File not found: ${relativePath}`);
  }

  if (!realFilePath.startsWith(realPluginDir + path.sep) && realFilePath !== realPluginDir) {
    throw new Error(`Path traversal denied: ${relativePath}`);
  }

  return realFilePath;
}

export function readPluginFileUtf8(pluginDir: string, relativePath: string): string {
  return fs.readFileSync(resolvePluginFilePath(pluginDir, relativePath), 'utf8');
}
