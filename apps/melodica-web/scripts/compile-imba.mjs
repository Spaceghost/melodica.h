import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(resolve('package.json'));
const { compile } = require('imba/compiler');

async function emit(source, destination, platform, runtimePath) {
  const contents = await readFile(source, 'utf8');
  const result = compile(contents, { sourcePath: source, platform, format: 'esm' });
  if (result.errors.length) {
    throw new Error(result.errors.map(({ message, range }) =>
      `${source}:${range.start.line + 1}:${range.start.character + 1} ${message}`).join('\n'));
  }
  const js = runtimePath ? result.js.replace("from 'imba/runtime'", `from '${runtimePath}'`) : result.js;
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, js);
}

async function compileDirectory(source, destination, platform, runtimePath) {
  const files = (await readdir(source)).filter(file => file.endsWith('.imba'));
  await Promise.all(files.map(file => emit(join(source, file),
    join(destination, file.replace(/\.imba$/, '.js')), platform, runtimePath)));
}

async function emitRuntime(destination) {
  const runtime = require.resolve('imba/runtime');
  const [license, source] = await Promise.all([
    readFile(resolve(dirname(runtime), '../../LICENSE'), 'utf8'),
    readFile(runtime, 'utf8'),
  ]);
  await writeFile(destination, '/*! Imba runtime\n' + license.trim() + '\n*/\n' + source);
}

if (process.argv[2] === 'site') {
  const site = join(root, 'site');
  await Promise.all([
    compileDirectory(join(site, 'src'), join(site, '.build'), 'node'),
    emit(join(root, 'web', 'listen-uri.imba'), join(site, '.build', 'listen-uri.js'), 'node'),
    emit(join(site, 'web', 'hub.imba'), join(site, 'public', 'melodica', 'hub.js'), 'browser', './imba-runtime.js'),
    emit(join(site, 'web', 'race.imba'), join(site, 'public', 'use', 'melodica', 'assets', 'race.js'), 'browser', '/melodica/imba-runtime.js'),
    emitRuntime(join(site, 'public', 'melodica', 'imba-runtime.js')),
  ]);
} else if (process.argv[2] === 'web') {
  const dist = join(root, 'dist');
  await compileDirectory(join(root, 'web'), dist, 'browser', './imba-runtime.js');
  await emitRuntime(join(dist, 'imba-runtime.js'));
} else {
  throw new Error('Usage: node scripts/compile-imba.mjs web|site');
}
