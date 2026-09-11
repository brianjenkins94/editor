/**
 * Node.js child_process module shim — STUBBED (just-bash removed).
 *
 * Upstream backed exec/spawn with just-bash (a browser bash interpreter, which itself pulls quickjs). The
 * editor's language servers (cspell, eslint, typescript) run via `runFile` and never spawn a child process,
 * so the whole just-bash-backed implementation is dead weight. This stub preserves the child_process API
 * surface — so any served code that merely references `require('child_process').X` still finds X — but every
 * operation fails the way a browser must: sync calls throw ENOSYS, async calls report ENOSYS via callback or
 * an 'error' event. If some tool genuinely needs to spawn, this fails loudly rather than silently.
 *
 * To restore the real implementation, recover shims/child_process.ts + shims/vfs-adapter.ts and the just-bash
 * dependency from macaly/almostnode@0.2.14.
 */

// Polyfill process (some deps read globalThis.process at import time).
if (typeof globalThis.process === 'undefined') {
  (globalThis as any).process = {
    env: {
      HOME: '/home/user',
      USER: 'user',
      PATH: '/usr/local/bin:/usr/bin:/bin',
      NODE_ENV: 'development',
    },
    cwd: () => '/',
    platform: 'linux',
    version: 'v18.0.0',
    versions: { node: '18.0.0' },
    stdout: { write: () => {} },
    stderr: { write: () => {} },
  };
}

import { EventEmitter } from './events';
import { Readable, Writable, Buffer } from './stream';
import type { VirtualFS } from '../virtual-fs';

const NOT_SUPPORTED = 'child_process is not supported in this environment (spawning is unavailable)';

function enosys(fn: string): Error & { code: string; errno: number; syscall: string } {
  const err = new Error(`${fn}: ${NOT_SUPPORTED}`) as Error & { code: string; errno: number; syscall: string };
  err.code = 'ENOSYS';
  err.errno = -38;
  err.syscall = fn;
  return err;
}

// --- Streaming/stdin no-ops (kept for API compatibility; nothing in the runtime uses them now) ---

export function setStreamingCallbacks(_opts: {
  onStdout?: (data: string) => void;
  onStderr?: (data: string) => void;
  signal?: AbortSignal;
}): void {
  /* no-op: no child processes to stream */
}

export function clearStreamingCallbacks(): void {
  /* no-op */
}

export function sendStdin(_data: string): void {
  /* no-op: no active child process */
}

/**
 * Previously wired a just-bash instance and custom node/npm commands onto the VFS. Now a no-op — the runtime
 * still calls this on construction, but there is nothing to initialize.
 */
export function initChildProcess(_vfs: VirtualFS): void {
  /* no-op */
}

// --- API surface (all operations fail with ENOSYS) ---

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  encoding?: BufferEncoding | 'buffer';
  timeout?: number;
  maxBuffer?: number;
  shell?: string | boolean;
}

export interface ExecResult {
  stdout: string | Buffer;
  stderr: string | Buffer;
}

export type ExecCallback = (
  error: Error | null,
  stdout: string | Buffer,
  stderr: string | Buffer
) => void;

export function exec(
  _command: string,
  optionsOrCallback?: ExecOptions | ExecCallback,
  maybeCallback?: ExecCallback,
): ChildProcess {
  const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
  const child = new ChildProcess();
  const err = enosys('exec');
  queueMicrotask(() => {
    if (callback) callback(err, '', '');
    child.emit('error', err);
  });
  return child;
}

export function execSync(_command: string, _options?: ExecOptions): string | Buffer {
  throw enosys('execSync');
}

export interface SpawnOptions {
  cwd?: string;
  env?: Record<string, string>;
  shell?: boolean | string;
  stdio?: 'pipe' | 'inherit' | 'ignore' | Array<'pipe' | 'inherit' | 'ignore'>;
}

export function spawn(_command: string, _args?: string[] | SpawnOptions, _options?: SpawnOptions): ChildProcess {
  const child = new ChildProcess();
  const err = enosys('spawn');
  queueMicrotask(() => {
    child.emit('error', err);
    child.emit('exit', 1, null);
  });
  return child;
}

export function spawnSync(_command: string, _args?: string[] | SpawnOptions, _options?: SpawnOptions): {
  pid: number;
  status: number | null;
  stdout: string | Buffer;
  stderr: string | Buffer;
  error?: Error;
} {
  return { pid: 0, status: null, stdout: '', stderr: '', error: enosys('spawnSync') };
}

export function execFile(
  _file: string,
  argsOrOptionsOrCallback?: string[] | ExecOptions | ExecCallback,
  optionsOrCallback?: ExecOptions | ExecCallback,
  maybeCallback?: ExecCallback,
): ChildProcess {
  const callback = [argsOrOptionsOrCallback, optionsOrCallback, maybeCallback].find(
    (a): a is ExecCallback => typeof a === 'function',
  );
  const child = new ChildProcess();
  const err = enosys('execFile');
  queueMicrotask(() => {
    if (callback) callback(err, '', '');
    child.emit('error', err);
  });
  return child;
}

export function fork(_modulePath: string, _args?: string[] | SpawnOptions, _options?: SpawnOptions): ChildProcess {
  const child = new ChildProcess();
  const err = enosys('fork');
  queueMicrotask(() => {
    child.emit('error', err);
    child.emit('exit', 1, null);
  });
  return child;
}

export class ChildProcess extends EventEmitter {
  pid: number;
  connected: boolean = false;
  killed: boolean = false;
  exitCode: number | null = null;
  signalCode: string | null = null;
  spawnargs: string[] = [];
  spawnfile: string = '';

  stdin: Writable | null;
  stdout: Readable | null;
  stderr: Readable | null;

  constructor() {
    super();
    this.pid = Math.floor(Math.random() * 10000) + 1000;
    this.stdin = new Writable();
    this.stdout = new Readable();
    this.stderr = new Readable();
  }

  kill(signal?: string): boolean {
    this.killed = true;
    this.emit('exit', null, signal || 'SIGTERM');
    return true;
  }

  disconnect(): void {
    this.connected = false;
  }

  send(_message: unknown, callback?: (error: Error | null) => void): boolean {
    if (callback) callback(new Error('IPC not supported'));
    return false;
  }

  ref(): this {
    return this;
  }

  unref(): this {
    return this;
  }
}

export default {
  exec,
  execSync,
  execFile,
  spawn,
  spawnSync,
  fork,
  ChildProcess,
  initChildProcess,
  setStreamingCallbacks,
  clearStreamingCallbacks,
  sendStdin,
};
