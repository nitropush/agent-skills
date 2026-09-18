import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, symlink, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
const init = new URL('../bin/init.mjs', import.meta.url).pathname;
const sync = new URL('../scripts/sync.mjs', import.meta.url).pathname;
for (const attack of ['leaf', 'ancestor']) for (const tool of ['init', 'sync']) {
  test(`${tool} refuses ${attack} symlinks without changing an outside file`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nitropush-scope-test-'));
    try {
      const root = join(dir, 'project'), outside = join(dir, 'outside');
      await mkdir(root); await mkdir(outside);
      const victim = join(outside, 'AGENTS.md'); await writeFile(victim, 'private sentinel');
      if (attack === 'leaf') await symlink(victim, join(root, 'AGENTS.md'));
      else await symlink(outside, join(root, '.claude'));
      const command = tool === 'init' ? [init, '--all', `--agents=${attack === 'leaf' ? 'codex' : 'claude'}`, '--scope=project'] : [sync, '--target', root];
      await assert.rejects(run(process.execPath, command, { cwd: root }), /unsafe target/);
      assert.equal(await readFile(victim, 'utf8'), 'private sentinel');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}
