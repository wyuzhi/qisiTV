import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = fileURLToPath(new URL('./configure-ubuntu-apt.sh', import.meta.url));

function fixture(t, files) {
  const root = mkdtempSync(join(tmpdir(), 'beeftv-apt-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ['sources.list.d', 'apt.conf.d', 'bin']) mkdirSync(join(root, dir));
  // Run the real edits on owned fixtures without invoking host sudo. BSD sed
  // needs an explicit empty backup suffix; CI executes the normal GNU form.
  writeFileSync(join(root, 'bin/sudo'), '#!/bin/bash\nif [[ "$1" == sed && "$(uname)" == Darwin ]]; then shift; shift; exec sed -i "" "$@"; fi\nexec "$@"\n', { mode: 0o755 });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(root, name), content);
  const run = () => {
    const result = spawnSync('bash', [script, root], { encoding: 'utf8', env: { ...process.env, PATH: join(root, 'bin') + ':' + process.env.PATH } });
    assert.equal(result.status, 0, result.stderr);
  };
  return { run, read: name => readFileSync(join(root, name), 'utf8') };
}

test('hosted Ubuntu mirror lists stop selecting Azure while preserving repository metadata', t => {
  const sources = 'Types: deb\nURIs: mirror+file:/etc/apt/apt-mirrors.txt\nSuites: noble noble-updates noble-security\nComponents: main universe\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n';
  const f = fixture(t, {
    'sources.list.d/ubuntu.sources': sources,
    'apt-mirrors.txt': 'http://azure.archive.ubuntu.com/ubuntu/\tpriority:1\nhttps://archive.ubuntu.com/ubuntu/\tpriority:2\n',
    'apt-mirrors-security.txt': 'https://azure.archive.ubuntu.com/ubuntu/\tpriority:1\n',
  });
  f.run();
  assert.equal(f.read('sources.list.d/ubuntu.sources'), sources);
  assert.equal(f.read('apt-mirrors.txt'), 'https://archive.ubuntu.com/ubuntu/\tpriority:1\nhttps://archive.ubuntu.com/ubuntu/\tpriority:2\n');
  assert.equal(f.read('apt-mirrors-security.txt'), 'https://archive.ubuntu.com/ubuntu/\tpriority:1\n');
  const first = f.read('apt-mirrors.txt');
  f.run();
  assert.equal(f.read('apt-mirrors.txt'), first);
  assert.match(f.read('apt.conf.d/80beeftv-network'), /Acquire::Retries "3";/);
  assert.match(f.read('apt.conf.d/80beeftv-network'), /Acquire::https::Timeout "30";/);
});

test('direct list and deb822 sources switch only the exact Azure host', t => {
  const unrelated = 'deb https://azureXarchive.ubuntu.com/ubuntu noble main\n';
  const f = fixture(t, {
    'sources.list': 'deb http://azure.archive.ubuntu.com/ubuntu noble main\n',
    'sources.list.d/ubuntu.sources': 'URIs: https://azure.archive.ubuntu.com/ubuntu/\nSuites: noble\n',
    'sources.list.d/other.list': unrelated,
  });
  f.run();
  assert.equal(f.read('sources.list'), 'deb https://archive.ubuntu.com/ubuntu noble main\n');
  assert.equal(f.read('sources.list.d/ubuntu.sources'), 'URIs: https://archive.ubuntu.com/ubuntu/\nSuites: noble\n');
  assert.equal(f.read('sources.list.d/other.list'), unrelated);
});

test('every Ubuntu dependency workflow applies the same mirror configuration', () => {
  for (const name of ['quality.yml', 'linux-desktop-check.yml', 'desktop-installers.yml', 'release-desktop.yml']) {
    const workflow = readFileSync(new URL('../.github/workflows/' + name, import.meta.url), 'utf8');
    assert.match(workflow, /bash (?:\.\.\/)?scripts\/configure-ubuntu-apt\.sh/);
  }
});
