import { parse } from 'acorn';
import { readFileSync } from 'node:fs';

export function readAppSource(file) {
  const source = readFileSync(file, 'utf8');
  const { body } = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  const functions = new Map(body.filter(node => node.type === 'FunctionDeclaration')
    .map(node => [node.id.name, source.slice(node.start, node.end)]));
  return name => {
    const declaration = functions.get(name);
    if (!declaration) throw new Error(`App function ${name} is missing from the build`);
    return declaration;
  };
}
