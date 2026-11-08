/** Source-composition tests against an explicitly selected local Harness checkout. */
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { defineConfig } from 'vitest/config';

export default defineConfig(async () => {
  const harness = resolve(process.env.DSH_SOURCE_DIR ?? '../deepseek-harness');
  const config = ts.readConfigFile(resolve(harness, 'tsconfig.base.json'), ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  const paths = config.config.compilerOptions.paths as Record<string, string[]>;
  const alias = Object.entries(paths).sort(([a], [b]) => b.length - a.length).map(([name, targets]) => ({
    find: new RegExp(`^${name.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('(.*)')}$`),
    replacement: resolve(harness, targets[0]!).replace('*', '$1'),
  }));
  alias.unshift({ find: /^@native-test\/(.*)$/, replacement: `${harness}/$1` });
  const { standardDecoratorPlugin, vitestExecArgv } = await import(pathToFileURL(resolve(harness, 'vitest.shared.ts')).href);
  const localRequire = createRequire(import.meta.url);
  const optionalRequire = createRequire(resolve(process.env.DSH_TEST_DEPS_DIR ?? '/tmp/qqbot-native-test-deps', 'package.json'));
  // A source checkout may not have compiled its platform addon; use the same
  // published native module when supplied, retaining real OS locking in tests.
  try { alias.unshift({ find: /^@deepseek-ai\/node-addon-system\/flock$/, replacement: optionalRequire.resolve('@deepseek-ai/node-addon-system/flock') }); } catch { /* The source checkout can supply its own compiled addon. */ }
  const store = resolve(harness, 'node_modules/.pnpm');
  const storedPackages = readdirSync(store);
  return {
    plugins: [standardDecoratorPlugin(), {
      name: 'qq-native-test-dependencies',
      resolveId(source: string, importer?: string) {
        if (!importer?.startsWith(harness) || source.startsWith('.') || source.startsWith('/') || source.startsWith('node:')) return;
        try { return createRequire(importer).resolve(source); } catch { /* Updated source can need packages absent from its old checkout install. */ }
        const packageName = source.startsWith('@') ? source.split('/').slice(0, 2).join('/') : source.split('/')[0]!;
        for (const entry of storedPackages.filter(entry => entry.startsWith(`${packageName.replace('/', '+')}@`))) {
          try { return createRequire(resolve(store, entry, 'package.json')).resolve(source); } catch { /* The workspace may have an incomplete virtual store entry. */ }
        }
        try { return optionalRequire.resolve(source); } catch { /* Optional isolated dependencies are not always necessary. */ }
        try { return localRequire.resolve(source); } catch { return undefined; }
      },
    }],
    resolve: { alias },
    test: {
      include: ['tests/*.integration.ts'],
      testTimeout: 15000,
      hookTimeout: 15000,
      execArgv: vitestExecArgv,
    },
  };
});
