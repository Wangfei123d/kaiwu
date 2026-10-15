// 三个测试文件共用一份"怎么找到假 agent 并把它起来"。各抄一遍迟早会分叉。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

export const FIXTURE = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..', 'fixtures', 'fake-acp-agent.mjs',
);

/** 起一个假 agent 子进程;args 透传给夹具(--crash-after / --noisy-stderr)。 */
export function spawnFake(args = []) {
    return spawn(process.execPath, [FIXTURE, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
}
