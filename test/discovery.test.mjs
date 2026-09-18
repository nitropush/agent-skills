import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
async function assertDiscoverable(target) {
  for (const [path, name] of [
    [".claude/skills/nitropush-nativescript/SKILL.md", true],
    [".cursor/rules/nitropush-nativescript.mdc", false],
    [".windsurf/rules/nitropush-nativescript.md", false],
  ]) {
    const output = await readFile(join(target, path), "utf8");
    assert(output.startsWith("---\n"), "frontmatter must be first, before comments: " + path);
    const end = output.indexOf("\n---", 4);
    assert(end > 0);
    const header = output.slice(4, end);
    if (name) assert.match(header, /^name: nitropush-nativescript$/m);
    assert.match(header, /^description: .+$/m);
    assert(output.indexOf("AUTO-GENERATED") > end);
  }
}
test("sync discovers NativeScript and emits valid frontmatter for every tool, idempotently", async () => {
  const target = await mkdtemp(join(tmpdir(), "nitropush-skill-sync-test-"));
  try {
    await run(process.execPath, [join(root, "scripts/sync.mjs"), "--target", target]);
    await assertDiscoverable(target);
    assert.match(await readFile(join(target, "AGENTS.md"), "utf8"), /## nitropush-nativescript/);
    const second = await run(process.execPath, [join(root, "scripts/sync.mjs"), "--target", target]);
    assert.match(second.stdout, /0 files changed/);
  } finally { await rm(target, { recursive: true, force: true }); }
});
test("packaged installer supports NativeScript selection with discoverable per-tool files", async () => {
  const target = await mkdtemp(join(tmpdir(), "nitropush-skill-install-test-"));
  try {
    await run(process.execPath, [join(root, "bin/init.mjs"), "init",
      "--skills=nitropush-nativescript", "--agents=claude,cursor,windsurf,codex", "--scope=project"],
    { cwd: target });
    await assertDiscoverable(target);
    assert.match(await readFile(join(target, "AGENTS.md"), "utf8"), /## nitropush-nativescript/);
  } finally { await rm(target, { recursive: true, force: true }); }
});
