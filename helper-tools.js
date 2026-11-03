import path from 'node:path';
import { constants } from 'node:fs';
import { realpath, stat, lstat, opendir, open } from 'node:fs/promises';

export const HELPER_TOOL = 'resident_workspace';
const MAX_FILE = 1024 * 1024;
const MAX_OUTPUT = 24000;
const MAX_ENTRIES = 200;
const SENSITIVE = /^(?:\.env(?:\..*)?|\.envrc|\.ssh|\.aws|\.azure|\.gnupg|\.kube|\.dsh|\.git|\.git-credentials|\.docker|\.config|\.npmrc|\.netrc|\.pypirc|\.bash_history|\.zsh_history|cookies(?:\.sqlite)?|login data|local state|keychains|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|credentials?(?:[._-].*)?|secrets?(?:[._-].*)?|tokens?(?:[._-].*)?|.*\.(?:pem|key|p12|pfx|keychain(?:-db)?))$/i;
export class WorkspaceError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
export function redactText(value) {
  return String(value)
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, '[private key redacted]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})\b/g, '[credential redacted]')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|authorization)\s*["']?\s*[:=]\s*)[^\r\n]+/gi, '$1[redacted]');
}
function allowedParts(relative) {
  return relative.split(/[\\/]/).every(part => !SENSITIVE.test(part));
}
function contained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}
export async function approvedRoot(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.length > 4096) throw new WorkspaceError('WORKSPACE_REQUIRED', '请先在 DSH 中选择并授权本机目录。');
  const root = await realpath(value);
  if (root === path.parse(root).root || !allowedParts(root)) throw new WorkspaceError('SENSITIVE_PATH', '请选择普通工作目录，不使用系统根目录或私密配置目录。');
  if (!(await stat(root)).isDirectory()) throw new WorkspaceError('WORKSPACE_REQUIRED', '授权位置必须是目录。');
  return root;
}
export async function workspaceOperation(rootValue, input, signal) {
  signal?.throwIfAborted();
  const root = await approvedRoot(rootValue);
  if (root !== path.resolve(rootValue)) throw new WorkspaceError('WORKSPACE_CHANGED', '授权目录的真实位置发生变化，请重新授权。');
  const requested = input?.path ?? '.';
  if (typeof requested !== 'string' || requested.length > 2048 || requested.includes('\0') || path.isAbsolute(requested) || requested.includes('\\')) throw new WorkspaceError('INVALID_PATH', '使用授权目录内的相对路径。');
  if (!allowedParts(requested)) throw new WorkspaceError('SENSITIVE_PATH', '不读取凭据或私密配置。');
  const lexical = path.resolve(root, requested);
  if (!contained(root, lexical)) throw new WorkspaceError('OUTSIDE_WORKSPACE', '路径超出了授权目录。');
  const resolved = await realpath(lexical);
  if (!contained(root, resolved) || !allowedParts(path.relative(root, resolved))) throw new WorkspaceError('OUTSIDE_WORKSPACE', '链接指向授权范围之外或私密配置。');
  const relative = path.relative(root, resolved) || '.';
  const info = await lstat(resolved);
  signal?.throwIfAborted();
  if (input.action === 'list') {
    if (!info.isDirectory()) throw new WorkspaceError('NOT_DIRECTORY', '该位置不是目录。');
    const entries = [];
    const directory = await opendir(resolved);
    let truncated = false;
    for await (const entry of directory) {
      signal?.throwIfAborted();
      if (!allowedParts(entry.name)) continue;
      if (entries.length === MAX_ENTRIES) { truncated = true; break; }
      entries.push({ name: entry.name, kind: entry.isSymbolicLink() ? 'link' : entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other' });
    }
    // Do not follow symlinks while listing or disclose their targets.
    entries.sort((a, b) => a.name.localeCompare(b.name));
    return { path: relative, entries, truncated };
  }
  if (input.action !== 'read') throw new WorkspaceError('INVALID_ACTION', '仅支持 list 和 read。');
  if (!info.isFile() || info.nlink !== 1) throw new WorkspaceError('NOT_REGULAR_FILE', '仅读取普通、非硬链接文件。');
  if (info.size > MAX_FILE) throw new WorkspaceError('FILE_TOO_LARGE', '文件超过 1 MiB，请选择较小的文字文件。');
  const offset = input.offset ?? 0;
  const limit = input.limit ?? 16000;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > MAX_FILE || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_OUTPUT) throw new WorkspaceError('INVALID_RANGE', '读取范围无效。');
  const handle = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const actual = await handle.stat();
    if (!actual.isFile() || actual.nlink !== 1 || actual.dev !== info.dev || actual.ino !== info.ino || actual.size > MAX_FILE) throw new WorkspaceError('FILE_CHANGED', '文件在读取前发生变化，请重新检查。');
    // Recheck the path after open; do not read a descriptor reached through a replaced parent symlink.
    if (await realpath(lexical) !== resolved || !contained(root, await realpath(resolved))) throw new WorkspaceError('FILE_CHANGED', '目录在读取前发生变化，请重新检查。');
    const buffer = Buffer.alloc(Math.min(actual.size, MAX_FILE));
    let read = 0;
    while (read < buffer.length) {
      signal?.throwIfAborted();
      const chunk = await handle.read(buffer, read, buffer.length - read, read);
      if (chunk.bytesRead === 0) break;
      read += chunk.bytesRead;
    }
    const bytes = buffer.subarray(0, read);
    if (bytes.includes(0)) throw new WorkspaceError('BINARY_FILE', '仅支持文字文件。');
    const safe = redactText(bytes.toString('utf8'));
    return { path: relative, offset, text: safe.slice(offset, offset + limit), totalCharacters: safe.length, truncated: offset + limit < safe.length };
  } finally { await handle.close(); }
}
export function workspaceTool(rootForAgent) {
  return {
    name: HELPER_TOOL,
    description: 'List or read text files in this helper’s authorized workspace. Returns relative paths and bounded results.',
    parameters: {
      action: { type: 'string', enum: ['list', 'read'], required: true },
      path: { type: 'string', description: 'Workspace-relative path; defaults to the root.' },
      offset: { type: 'integer', description: 'Read character offset, default 0.' },
      limit: { type: 'integer', description: 'Read characters, default 16000, maximum 24000.' }
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, execution) {
      try { return await workspaceOperation(await rootForAgent(execution.agent), args, execution.signal); }
      catch (error) {
        if (error instanceof WorkspaceError) return { error: error.code, message: error.message };
        if (execution.signal?.aborted) return { error: 'CANCELLED', message: '操作已取消。' };
        return { error: 'READ_FAILED', message: '无法读取所选文件或目录。' };
      }
    }
  };
}
