import { Worker } from 'node:worker_threads';

const CONVERT_TIMEOUT_MS = 15000;

/**
 * Convert one DOCX buffer into semantic HTML for the read-only reader.
 * Mammoth receives no path and external file access stays disabled.
 * @param {Buffer} buffer
 * @returns {Promise<{html:string,messages:Array<{type:string,message:string}>}>}
 */
export function convertDocxBuffer(buffer) {
    if (!Buffer.isBuffer(buffer)) throw new TypeError('DOCX 内容必须是 Buffer');
    return new Promise((resolve, reject) => {
        const worker = new Worker(new URL('./docx-reader-worker.js', import.meta.url), {
            workerData: buffer,
            resourceLimits: { maxOldGenerationSizeMb: 256 },
        });
        let settled = false;
        const finish = (fn, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            fn(value);
        };
        const timer = setTimeout(() => {
            void worker.terminate();
            finish(reject, new Error('DOCX 解析超时(15 秒)'));
        }, CONVERT_TIMEOUT_MS);
        worker.once('message', (message) => {
            if (message?.ok === true) finish(resolve, message.result);
            else finish(reject, new Error(String(message?.error ?? 'DOCX 文档无法解析')));
        });
        worker.once('error', (err) => finish(reject, err));
        worker.once('exit', (code) => {
            if (!settled && code !== 0) finish(reject, new Error(`DOCX 解析进程异常结束(${code})`));
            else if (!settled) finish(reject, new Error('DOCX 解析未返回结果'));
        });
    });
}
