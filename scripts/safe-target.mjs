import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

// The selected root is the authority boundary. Refuse checkout-supplied links
// below it, including cleanup paths. This is not an OS sandbox against a local
// process concurrently renaming ancestor directories.
export async function assertSafeTarget(root, target, createParents = false) {
  root = resolve(root); target = resolve(target);
  const rel = relative(root, target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Target escapes selected scope');
  const rootStat = await lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error('Unsafe selected root');
  let current = root;
  const parts = rel ? rel.split(sep) : [];
  for (let i = 0; i < parts.length; i++) {
    current = resolve(current, parts[i]);
    let info;
    try { info = await lstat(current); } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      if (i === parts.length - 1 || !createParents) return target;
      await mkdir(current);
      info = await lstat(current);
    }
    if (info.isSymbolicLink() || (i < parts.length - 1 && !info.isDirectory())) {
      throw new Error(`Refusing unsafe target: ${current}`);
    }
  }
  return target;
}

export async function writeSafeTarget(root, target, content) {
  await assertSafeTarget(root, target, true);
  const temporary = resolve(dirname(target), `.nitropush-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
    await handle.writeFile(content, 'utf8');
    await handle.close(); handle = undefined;
    await assertSafeTarget(root, target);
    await rename(temporary, target);
  } finally {
    await handle?.close();
    await unlink(temporary).catch(err => { if (err.code !== 'ENOENT') throw err; });
  }
}

export async function readSafeTarget(root, target, maximum = 1024 * 1024) {
  await assertSafeTarget(root, target);
  let handle;
  try {
    handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!(await handle.stat()).isFile()) throw new Error('Target is not a regular file');
    const buffer = Buffer.alloc(maximum);
    const { bytesRead } = await handle.read(buffer, 0, maximum, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  } finally { await handle?.close(); }
}
