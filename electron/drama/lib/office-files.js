import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// WPS 原生格式与 WPS 常用的 Office 兼容格式。
export const OFFICE_FILE_EXTENSIONS = Object.freeze([
    'wps', 'et', 'dps', 'wpt', 'ett', 'dpt', 'docx', 'xlsx', 'pptx',
]);
export const MAX_OFFICE_FILE_BYTES = 50 * 1024 * 1024;

const OFFICE_EXTENSION_SET = new Set(OFFICE_FILE_EXTENSIONS);
const PROJECT_FILE_PATTERN = /^files\/[0-9a-f-]{36}\.[a-z0-9]{1,8}$/i;
const PROJECT_GENERATED_OUTPUT_PATTERN = /^outputs\/[0-9a-f-]{36}\.(?:docx|md|txt|html|json|csv)$/i;

/** 将用户明确选中的本地文件复制到短剧项目内，节点只保存相对路径。 */
export function importProjectOfficeFile(projectDir, sourcePath) {
    if (typeof sourcePath !== 'string' || !path.isAbsolute(sourcePath)) {
        throw new Error('请选择本地 WPS 文件');
    }
    const source = path.resolve(sourcePath);
    const extension = path.extname(source).slice(1).toLowerCase();
    if (!OFFICE_EXTENSION_SET.has(extension)) {
        throw new Error(`暂不支持 .${extension || '(无扩展名)'} 文件`);
    }
    const stat = fs.statSync(source);
    if (!stat.isFile()) throw new Error('所选项目不是文件');
    if (stat.size <= 0) throw new Error('文件为空');
    if (stat.size > MAX_OFFICE_FILE_BYTES) {
        throw new Error(`文件超过 ${Math.round(MAX_OFFICE_FILE_BYTES / 1024 / 1024)} MB 上限`);
    }

    const filesDir = path.join(projectDir, 'files');
    fs.mkdirSync(filesDir, { recursive: true });
    const realProject = fs.realpathSync(projectDir);
    const realFilesDir = fs.realpathSync(filesDir);
    if (!realFilesDir.startsWith(realProject + path.sep)) {
        throw new Error('项目文件目录必须位于当前项目内');
    }
    const storedName = `${randomUUID()}.${extension}`;
    const target = path.join(realFilesDir, storedName);
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
    const saved = fs.statSync(target);
    if (!saved.isFile() || saved.size !== stat.size || saved.size > MAX_OFFICE_FILE_BYTES) {
        fs.unlinkSync(target);
        throw new Error('文件复制校验失败，请重试');
    }
    return {
        file: `files/${storedName}`,
        name: path.basename(source),
        extension,
        size: saved.size,
    };
}

/** 只打开当前项目 files/ 下由导入器生成的文件名，不接受绝对路径。 */
export function resolveProjectOfficeFile(projectDir, file) {
    if (typeof file !== 'string' || !PROJECT_FILE_PATTERN.test(file)) {
        throw new Error('WPS 文件路径无效');
    }
    const filesDir = path.resolve(projectDir, 'files');
    const target = path.resolve(projectDir, file);
    if (!target.startsWith(filesDir + path.sep)) throw new Error('只能打开项目中的 WPS 文件');
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) throw new Error('文件已不存在');
    const realDir = fs.realpathSync(filesDir);
    const realTarget = fs.realpathSync(target);
    const realProject = fs.realpathSync(projectDir);
    if (!realDir.startsWith(realProject + path.sep)
        || !realTarget.startsWith(realDir + path.sep)) throw new Error('WPS 文件超出项目目录');
    return realTarget;
}

/** 只打开运行节点生成且扩展名在白名单内的项目 outputs/ 文件。 */
export function resolveProjectGeneratedOutput(projectDir, file) {
    if (typeof file !== 'string' || !PROJECT_GENERATED_OUTPUT_PATTERN.test(file)) {
        throw new Error('导出文件路径无效');
    }
    const outputsDir = path.resolve(projectDir, 'outputs');
    const target = path.resolve(projectDir, file);
    if (!target.startsWith(outputsDir + path.sep)) throw new Error('只能打开项目中的导出文件');
    if (!fs.existsSync(outputsDir) || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
        throw new Error('导出文件已不存在');
    }
    const realDir = fs.realpathSync(outputsDir);
    const realTarget = fs.realpathSync(target);
    const realProject = fs.realpathSync(projectDir);
    if (!realDir.startsWith(realProject + path.sep)
        || !realTarget.startsWith(realDir + path.sep)) throw new Error('导出文件超出项目目录');
    return realTarget;
}
