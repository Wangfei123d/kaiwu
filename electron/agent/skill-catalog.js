import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const MAX_SKILL_BYTES = 512 * 1024;
const SAFE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function cleanScalar(value) {
    const raw = String(value ?? '').trim();
    if (raw.startsWith('"') && raw.endsWith('"')) {
        try { return JSON.parse(raw); } catch { return raw.slice(1, -1); }
    }
    if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1).replaceAll("''", "'");
    return raw.replace(/\s+#.*$/, '').trim();
}
function frontMatterOf(text) {
    const match = String(text).match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    if (!match) return null;
    const lines = match[1].split(/\r?\n/);
    const field = (key) => {
        const at = lines.findIndex(line => new RegExp(`^${key}:\\s*`).test(line));
        if (at < 0) return '';
        const line = lines[at].replace(new RegExp(`^${key}:\\s*`), '');
        if (/^[>|][+-]?$/.test(line.trim())) {
            const parts = [];
            for (let i = at + 1; i < lines.length && /^\s+/.test(lines[i]); i += 1) parts.push(lines[i].trim());
            return parts.join(' ').trim();
        }
        return cleanScalar(line);
    };
    const bool = (key, fallback) => {
        const value = field(key).toLowerCase();
        if (['true', 'yes', 'on', '1'].includes(value)) return true;
        if (['false', 'no', 'off', '0'].includes(value)) return false;
        return fallback;
    };
    return {
        name: field('name'),
        description: field('description'),
        whenToUse: field('whenToUse'),
        disableModelInvocation: bool('disable-model-invocation', false),
        userInvocable: bool('user-invocable', true),
        end: match[0].length,
    };
}

function sourceLabel(key) {
    if (key === 'project-agents' || key === 'project-dsh') return '工作区';
    if (key === 'bundled') return '内置';
    return '用户';
}

async function realDirectory(filePath) {
    try {
        const info = await fs.lstat(filePath);
        if (!info.isDirectory() || info.isSymbolicLink()) return null;
        return await fs.realpath(filePath);
    } catch { return null; }
}

async function readSkillFile(filePath, rootPath) {
    try {
        const realPath = await fs.realpath(filePath);
        const relative = path.relative(rootPath, realPath);
        if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return null;
        if (path.resolve(realPath) !== path.resolve(filePath)) return null;
        const info = await fs.lstat(filePath);
        if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_SKILL_BYTES) return null;
        return await fs.readFile(filePath, 'utf8');
    } catch { return null; }
}

/**
 * Read-only view of the same filesystem roots used by DSH's filesystem Skill provider.
 * Root paths are supplied by the main process; the renderer can only read by catalog id.
 */
export function createAgentSkillCatalog({ getRoots } = {}) {
    if (typeof getRoots !== 'function') throw new Error('Skill 清单需要 getRoots');

    async function scan() {
        const roots = (await getRoots()).filter(root => root && typeof root.path === 'string' && root.path !== '');
        const seenRoots = new Set();
        const seenNames = new Set();
        const skills = [];

        for (const root of roots) {
            const realRoot = await realDirectory(root.path);
            if (realRoot === null) continue;
            const rootKey = process.platform === 'win32' ? realRoot.toLowerCase() : realRoot;
            if (seenRoots.has(rootKey)) continue;
            seenRoots.add(rootKey);

            let entries;
            try { entries = await fs.readdir(realRoot, { withFileTypes: true }); }
            catch { continue; }

            for (const entry of entries) {
                if (root.key === 'user-dsh' && entry.name === '.system') continue;
                let filePath;
                let relativePath;
                if (entry.isDirectory() && !entry.isSymbolicLink()) {
                    filePath = path.join(realRoot, entry.name, 'SKILL.md');
                    relativePath = `${root.relative}/${entry.name}/SKILL.md`;
                } else if (entry.isFile() && !entry.isSymbolicLink() && entry.name.toLowerCase().endsWith('.md')) {
                    filePath = path.join(realRoot, entry.name);
                    relativePath = `${root.relative}/${entry.name}`;
                } else continue;

                const text = await readSkillFile(filePath, realRoot);
                if (text === null) continue;
                const meta = frontMatterOf(text);
                if (meta === null || !SAFE_NAME.test(meta.name) || meta.description === '') continue;
                // DSH resolves duplicate names by provider priority. Keep that first, effective copy.
                if (seenNames.has(meta.name)) continue;
                seenNames.add(meta.name);
                skills.push({
                    id: createHash('sha256').update(`${root.key}\0${meta.name}`).digest('hex').slice(0, 24),
                    name: meta.name,
                    description: meta.description,
                    whenToUse: meta.whenToUse,
                    source: sourceLabel(root.key),
                    path: relativePath.replaceAll('\\', '/'),
                    available: !meta.disableModelInvocation || meta.userInvocable,
                    autoMatch: !meta.disableModelInvocation,
                    userInvocable: meta.userInvocable,
                    content: text,
                    instructions: text.slice(meta.end).trim(),
                    updatedAt: (await fs.stat(filePath).catch(() => null))?.mtimeMs ?? 0,
                });
            }
        }

        skills.sort((a, b) => a.name.localeCompare(b.name));
        return skills;
    }

    return Object.freeze({
        async list() {
            const skills = await scan();
            return { ok: true, skills: skills.map(({ content, instructions, ...item }) => item) };
        },
        async read(id) {
            if (typeof id !== 'string' || id.trim() === '') throw new Error('Skill id 必填');
            const item = (await scan()).find(skill => skill.id === id);
            if (!item) return { ok: false, reason: 'Skill 已不存在或不可用' };
            return { ok: true, skill: item };
        },
    });
}

