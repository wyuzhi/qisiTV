import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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

function checkHostedAptJobs(workflow, name) {
  let checked = 0;
  // A setup in another job cannot configure this runner. Container-only apt
  // commands have their own image repositories, not the hosted Azure mirrors.
  for (const job of workflow.split(/^  [\w-]+:\s*$/m).slice(1)) {
    const commands = [...job.matchAll(/\bsudo\s+apt(?:-get)?\s+(?:update|install)\b/g)];
    if (!commands.length) continue;
    const setup = job.search(/bash (?:\.\.\/)?scripts\/configure-ubuntu-apt\.sh/);
    assert.ok(setup >= 0 && commands.every(command => setup < command.index), `${name}: configure mirrors in the same job before hosted apt commands`);
    checked++;
  }
  return checked;
}

test('every job installing hosted Ubuntu dependencies configures mirrors before apt', () => {
  const directory = new URL('../.github/workflows/', import.meta.url);
  let checked = 0;
  for (const name of readdirSync(directory).filter(name => /\.ya?ml$/.test(name))) {
    checked += checkHostedAptJobs(readFileSync(new URL(name, directory), 'utf8'), name);
  }
  assert.ok(checked > 0, 'expected to check actual hosted Ubuntu dependency jobs');
});

test('mirror gate rejects missing, late and other-job setup without requiring apt on macOS or Windows', () => {
  const setup = '      - run: bash scripts/configure-ubuntu-apt.sh\n';
  const install = '      - run: sudo apt-get install -y ffmpeg\n';
  assert.throws(() => checkHostedAptJobs('jobs:\n  linux:\n' + install, 'missing'));
  assert.throws(() => checkHostedAptJobs('jobs:\n  linux:\n' + install + setup, 'late'));
  assert.throws(() => checkHostedAptJobs('jobs:\n  first:\n' + setup + '  second:\n' + install, 'other job'));
  assert.equal(checkHostedAptJobs('jobs:\n  linux:\n' + setup + install, 'configured'), 1);
  assert.equal(checkHostedAptJobs('jobs:\n  desktop:\n    runs-on: macos-latest\n      - run: ./scripts/build-qisitv-release.sh\n', 'macOS'), 0);
});
