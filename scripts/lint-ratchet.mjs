#!/usr/bin/env node
// Existing lint debt, including tests, is a set of exact file/rule pairs.
// Regeneration removes resolved pairs; CI compares allowances with a Git base.
import { execFileSync } from 'node:child_process';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { canRatchet } from './eslint-policy.mjs';
import { parseArgs } from 'node:util';
import { format, resolveConfig } from 'prettier';

const { values } = parseArgs({
  options: {
    check: { type: 'boolean' },
    'base-ref': { type: 'string' },
    dir: { type: 'string', default: '.' },
  },
});
if (!['.', 'ui'].includes(values.dir)) throw new Error('--dir must be . or ui');
const ui = values.dir === 'ui';
const repository = fileURLToPath(new URL('../', import.meta.url));
const root = path.join(repository, values.dir);
await checkBulkSuppressions();
const configPath = path.join(root, 'eslint.config.mjs');
const configFile = ui ? 'ui/eslint.config.mjs' : 'eslint.config.mjs';
const require = createRequire(configPath);
const { parse } = require('@typescript-eslint/parser');
const { ESLint } = require('eslint');
const { baseConfig, lintRatchet, strictFiles } = await import(pathToFileURL(configPath).href);
const check = values.check ?? false;
const baseRef = values['base-ref'];
if (baseRef !== undefined && !baseRef.trim()) throw new Error('--base-ref must be a Git ref');
const start = '// BEGIN LINT RATCHET';
const end = '// END LINT RATCHET';
const source = await readFile(configPath, 'utf8');
const { from, to } = blockBounds(source);
const previous = collectPairs(lintRatchet);

if (baseRef !== undefined) {
  const git = (args) => execFileSync('git', args, { cwd: repository, encoding: 'utf8' });
  const commit = git(['rev-parse', '--verify', '--end-of-options', `${baseRef}^{commit}`]).trim();
  await checkTypeScriptDirectives(git, commit);
  const paths = git(['ls-tree', '--name-only', commit, '--', configFile]).trim();
  const baseSource = paths ? git(['show', `${commit}:${configFile}`]) : '';
  // Only the migration from the legacy filename may establish a baseline.
  if (!paths) git(['cat-file', '-e', `${commit}:${ui ? 'ui/' : ''}.eslintrc.cjs`]);
  const bounds = blockBounds(baseSource, true);
  if (bounds === null && paths) {
    throw new Error('The base flat config must contain a ratchet block');
  }
  if (bounds === null) {
    console.log(`lint-ratchet: ${baseRef} has no ratchet block yet; initial baseline allowed`);
  } else {
    // Read only the literal data block. Never execute a historical config or
    // depend on its imports matching the current installation.
    const block = baseSource.slice(bounds.from + start.length, bounds.to);
    const baseline = collectPairs(parseRatchet(block));
    const grown = [...previous].filter((pair) => !baseline.has(pair)).sort();
    if (grown.length) {
      console.error(
        `lint-ratchet: ${grown.length} pairs added against ${baseRef}; only removals are allowed:\n${grown.join('\n')}`
      );
      process.exit(1);
    }
    console.log(`lint-ratchet: shrink-only comparison passed against ${baseRef} (${commit})`);
  }
}

const eslint = new ESLint({
  cwd: root,
  applySuppressions: false,
  overrideConfigFile: true,
  overrideConfig: baseConfig,
});
const results = await eslint.lintFiles(strictFiles);
const current = new Map();
let reports = 0;
for (const result of results) {
  const file = path.relative(root, result.filePath).split(path.sep).join('/');
  for (const message of result.messages) {
    if (message.fatal || !message.ruleId) {
      throw new Error(`${file}:${message.line}: ${message.message}`);
    }
    if (!current.has(file)) current.set(file, new Set());
    current.get(file).add(message.ruleId);
    reports += 1;
  }
}

const pairs = new Set(
  [...current].flatMap(([file, rules]) => [...rules].map((rule) => `${file}: ${rule}`))
);
const added = [...pairs].filter((pair) => !previous.has(pair)).sort();
const stale = [...previous].filter((pair) => !pairs.has(pair)).sort();
if (added.length) {
  console.error(`lint-ratchet: fix ${added.length} new file/rule pairs:\n${added.join('\n')}`);
  process.exit(1);
}
if (check && stale.length) {
  console.error(
    `lint-ratchet: remove ${stale.length} stale pairs with npm run lint:ratchet:update:\n${stale.join('\n')}`
  );
  process.exit(1);
}

const entries = [...current.keys()].sort().map((file) => ({
  files: [file],
  rules: Object.fromEntries([...current.get(file)].sort().map((rule) => [rule, 'off'])),
}));
const block = (
  await format(`${start}\nexport const lintRatchet = ${JSON.stringify(entries)};\n${end}`, {
    ...(await resolveConfig(configPath)),
    filepath: configPath,
  })
).trimEnd();
const oldBlock = source.slice(from, to + end.length);
if (check && oldBlock !== block) {
  console.error(
    'lint-ratchet: block must be sorted and canonical; run npm run lint:ratchet:update'
  );
  process.exit(1);
}
if (!check && oldBlock !== block) {
  await writeFile(configPath, source.slice(0, from) + block + source.slice(to + end.length));
}
console.log(
  `lint-ratchet: OK (${pairs.size} pairs, ${current.size} files, ${reports} reports${check ? '' : `, ${stale.length} pairs removed`})`
);

async function checkBulkSuppressions() {
  // Inspect the filesystem, including ignored files, for both package checks.
  const files = await readdir(repository, { recursive: true, withFileTypes: true });
  const violations = files
    .filter((entry) => entry.name === 'eslint-suppressions.json')
    .map((entry) => path.relative(repository, path.join(entry.parentPath, entry.name)));
  for (const file of ['package.json', 'ui/package.json']) {
    const { scripts } = JSON.parse(await readFile(path.join(repository, file), 'utf8'));
    for (const [name, command] of Object.entries(scripts)) {
      if (command.includes('--suppressions-location')) {
        violations.push(`${file}: scripts.${name} uses --suppressions-location`);
      }
    }
  }
  if (violations.length) {
    console.error(
      `lint-ratchet: bulk suppressions are forbidden:\n${violations.sort().join('\n')}`
    );
    process.exit(1);
  }
}

async function checkTypeScriptDirectives(git, commit) {
  // Count raw substrings in every changed or untracked file. Comment parsing
  // can miss effective TypeScript directives after a carriage return.
  const changed = git([
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--name-only',
    '-z',
    '--no-renames',
    '--diff-filter=ACMT',
    commit,
    '--',
  ]).split('\0');
  const untracked = git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0');
  const files = [...new Set([...changed, ...untracked])].filter(Boolean).sort();
  const baseFiles = new Set(git(['ls-tree', '-r', '--name-only', '-z', commit]).split('\0'));
  const grown = [];
  for (const file of files) {
    const current = await readFile(path.join(repository, file), 'utf8');
    const baseline = baseFiles.has(file) ? git(['show', `${commit}:${file}`]) : '';
    for (const name of ['ignore', 'expect-error', 'nocheck']) {
      const directive = `@ts-${name}`;
      const before = baseline.split(directive).length - 1;
      const after = current.split(directive).length - 1;
      if (after > before) grown.push(`${file}: ${directive} ${before} -> ${after}`);
    }
  }
  if (grown.length) {
    console.error(
      `lint-ratchet: TypeScript directive counts grew against ${baseRef}:\n${grown.join('\n')}`
    );
    process.exit(1);
  }
  console.log(`lint-ratchet: TypeScript directive counts did not grow against ${baseRef}`);
}

function blockBounds(text, allowMissing = false) {
  const from = text.indexOf(start);
  const to = text.indexOf(end);
  if (allowMissing && from === -1 && to === -1) return null;
  if (
    from < 0 ||
    to < from ||
    text.indexOf(start, from + 1) !== -1 ||
    text.indexOf(end, to + 1) !== -1
  ) {
    throw new Error('Expected one lint ratchet block in eslint.config.mjs');
  }
  return { from, to };
}

function parseRatchet(block) {
  const { body } = parse(block, { sourceType: 'module', ecmaVersion: 'latest' });
  const statement = body[0];
  const declaration = statement?.declaration;
  if (
    body.length !== 1 ||
    statement.type !== 'ExportNamedDeclaration' ||
    declaration?.type !== 'VariableDeclaration' ||
    declaration.kind !== 'const' ||
    declaration.declarations.length !== 1 ||
    declaration.declarations[0].id.type !== 'Identifier' ||
    declaration.declarations[0].id.name !== 'lintRatchet'
  ) {
    throw new Error('Expected an exported const lintRatchet data block in the base config');
  }
  return readLiteral(declaration.declarations[0].init);
}

function readLiteral(node) {
  if (node?.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node?.type === 'ArrayExpression') return node.elements.map(readLiteral);
  if (node?.type === 'ObjectExpression') {
    const entries = node.properties.map((property) => {
      if (
        property.type !== 'Property' ||
        property.computed ||
        property.method ||
        property.shorthand ||
        property.kind !== 'init'
      ) {
        throw new Error('Ratchet objects must contain literal properties');
      }
      const key =
        property.key.type === 'Identifier' ? property.key.name : readLiteral(property.key);
      return [key, readLiteral(property.value)];
    });
    if (new Set(entries.map(([key]) => key)).size !== entries.length) {
      throw new Error('Duplicate property in the base ratchet');
    }
    return Object.fromEntries(entries);
  }
  throw new Error('Ratchet data must contain only arrays, objects and strings');
}

function collectPairs(entries) {
  if (!Array.isArray(entries)) throw new Error('Ratchet must be an array');
  const pairs = new Set();
  for (const entry of entries) {
    if (
      !entry ||
      !Array.isArray(entry.files) ||
      entry.files.length !== 1 ||
      Object.keys(entry).sort().join() !== 'files,rules' ||
      !entry.rules ||
      typeof entry.rules !== 'object' ||
      Array.isArray(entry.rules)
    ) {
      throw new Error('Ratchet entries must contain one exact file and its rules');
    }
    const [file] = entry.files;
    if (
      typeof file !== 'string' ||
      !(
        file.startsWith('src/') ||
        file.startsWith('test/') ||
        (!ui && (file.startsWith('example/') || file === 'test-e2e.mjs'))
      ) ||
      !/\.(?:ts|js|mjs)$/u.test(file) ||
      /[*?{}[\]!]/u.test(file) ||
      file.includes('\\') ||
      path.posix.normalize(file) !== file
    ) {
      throw new Error(`Ratchet file must be an exact source or test path: ${file}`);
    }
    for (const [rule, severity] of Object.entries(entry.rules)) {
      const pair = `${file}: ${rule}`;
      if (severity !== 'off' || pairs.has(pair)) {
        throw new Error(`Invalid or duplicate ratchet pair: ${pair}`);
      }
      // The migration may only baseline rules that were disabled on this file.
      // Crypto, WebCrypto, randomness and UI boundaries stay load-bearing.
      if (!canRatchet(file, rule, ui)) {
        throw new Error(`Ratchet cannot suppress a legacy-enforced rule: ${pair}`);
      }
      pairs.add(pair);
    }
  }
  return pairs;
}
