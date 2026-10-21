#!/usr/bin/env node
// Writes the package.json that ships inside the Linux and Windows preview
// packages (script/package_linux.sh, script/package_windows.{ps1,mjs}).
//
// A downloaded package is installed with `npm install --omit=dev` from the
// public npm registry alone: it ships no .npmrc and no lockfile. npm still
// resolves devDependencies before omitting them, and one of them
// (@owl-kestrel/hatch-contracts) exists only on the private Owl + Kestrel
// registry, so the packaged package.json drops devDependencies. The packaged
// runtime never imports them. The source package.json is unchanged.
//
// Usage: node script/packaged_package_json.mjs <source package.json> <destination>
import { realpathSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export function packagedPackageJson(source) {
  const { devDependencies: _devDependencies, ...packaged } = source;
  return packaged;
}

export async function writePackagedPackageJson(sourcePath, destinationPath) {
  const source = JSON.parse(await readFile(sourcePath, 'utf8'));
  await writeFile(destinationPath, `${JSON.stringify(packagedPackageJson(source), null, 2)}\n`, 'utf8');
}

// Node resolves the entry script's symlinks (e.g. macOS /tmp -> /private/tmp)
// in import.meta.url, so compare against the real path of argv[1].
if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  const [sourcePath, destinationPath] = process.argv.slice(2);
  if (!sourcePath || !destinationPath) {
    console.error('Usage: packaged_package_json.mjs <source package.json> <destination>');
    process.exit(2);
  }
  await writePackagedPackageJson(sourcePath, destinationPath);
}
