/* ============================================================
   字幕格式互转 —— 插件入口
   ------------------------------------------------------------
   解析 / 序列化算法全在 ./convert.js(纯函数,可单测,见设计文档 §11.1),
   这里只做界面绑定:输入监听、转换、复制、下载、拖入文件。

   为什么所有 DOM 查询都在 setup(el, ctx) 里:
   面板 HTML 要到用户第一次点开这个工具时才注入(设计文档 §5.3),
   在模块顶层写 document.getElementById(...) 只会拿到 null ——
   旧站的 tool-subtitle.js 正是这么写的,所以移植时必须改掉。
   查询一律走 el.querySelector('#...'),锁定在本面板内。
   ============================================================ */

import { toast, copyText, downloadBlob } from 'toolbox://shell/lib/utils.js';
import { convertSubtitle, detectSubtitleFormat, FORMAT_LABELS } from './convert.js';

export default {
    /* 启动时只注册贡献点,不碰 DOM。面板以文件路径给出,由运行时 fetch 后注入。 */
    activate(ctx) {
        ctx.tools.register({
            id: 'subtitle',
            title: '字幕格式互转',
            icon: 'subtitle',
            order: 20,
            panel: 'panel.html',
            style: 'style.css',
        });
        ctx.log.info('字幕格式互转已就绪');
    },

    /* 首次打开该工具时调用,el 是已挂载的面板容器。 */
    setup(el) {
        const input = el.querySelector('#subtitleInput');
        const target = el.querySelector('#subtitleTarget');
        const runBtn = el.querySelector('#subtitleRun');
        const clearBtn = el.querySelector('#subtitleClear');
        const output = el.querySelector('#subtitleOutput');
        const copyBtn = el.querySelector('#subtitleCopy');
        const downloadBtn = el.querySelector('#subtitleDownload');
        const detected = el.querySelector('#subtitleDetected');
        const status = el.querySelector('#subtitleStatus');
        const count = el.querySelector('#subtitleCount');

        /* 把状态行的文案和配色一起换掉。
           配色类名有两种:成功用 status-ok、失败用 status-error,
           都定义在 base.css 里,插件不自己定义颜色。 */
        function setStatus(message, kind = '') {
            status.textContent = message;
            status.className = 'hint mt-sm' + (kind ? ' status-' + kind : '');
        }

        /* 输出区可用性:没有结果时两个按钮都该是灰的 */
        function setOutputReady(ready) {
            copyBtn.disabled = !ready;
            downloadBtn.disabled = !ready;
        }

        /* 输入内容变化时,实时告诉用户识别到了什么格式 */
        function updateDetected() {
            const format = detectSubtitleFormat(input.value);

            if (!format) {
                detected.textContent = input.value.trim() ? '认不出来' : '等待输入…';
                return;
            }

            detected.textContent = FORMAT_LABELS[format];
        }

        function runConversion() {
            /* 真正的转换交给纯函数。它从不抛异常,失败原因装在 error 里 */
            const result = convertSubtitle(input.value, target.value);

            if (!result.ok) {
                output.value = '';
                setOutputReady(false);
                count.textContent = '';
                setStatus(result.error, 'error');
                return;
            }

            output.value = result.output;
            setOutputReady(true);
            count.textContent = `共 ${result.cueCount} 条字幕`;

            setStatus(
                result.format === target.value
                    ? `源格式和目标格式都是 ${FORMAT_LABELS[target.value]}，已重新整理输出`
                    : `${FORMAT_LABELS[result.format]} → ${FORMAT_LABELS[target.value]} 转换完成`,
                'ok'
            );
        }

        input.addEventListener('input', updateDetected);

        runBtn.addEventListener('click', runConversion);

        clearBtn.addEventListener('click', () => {
            input.value = '';
            output.value = '';
            setOutputReady(false);
            count.textContent = '';
            setStatus('');
            updateDetected();
        });

        copyBtn.addEventListener('click', () => {
            if (output.value) copyText(output.value);
        });

        downloadBtn.addEventListener('click', () => {
            if (!output.value) return;
            /* 字幕本来就是纯文本,用 text/plain 就够了 */
            const format = target.value;
            const blob = new Blob([output.value], { type: 'text/plain;charset=utf-8' });
            downloadBlob(blob, `subtitle.${format}`);
        });

        /* ---- 把 .srt / .vtt / .ass 文件直接拖到输入框上 ---- */
        /* 这里不用 setupDropZone:那个是给"上传区"用的,而本工具的目标
           本身就是可编辑的文本框,拖进来要有自己的一套高亮 + 读文件逻辑 */
        ['dragenter', 'dragover'].forEach(type => {
            input.addEventListener(type, e => {
                e.preventDefault();             /* 不阻止的话浏览器会直接打开这个文件 */
                input.classList.add('dragover');
            });
        });

        ['dragleave', 'drop'].forEach(type => {
            input.addEventListener(type, e => {
                e.preventDefault();
                input.classList.remove('dragover');
            });
        });

        input.addEventListener('drop', async e => {
            const file = e.dataTransfer?.files?.[0];
            if (!file) return;

            try {
                input.value = await file.text();    /* 字幕是纯文本,直接读成字符串 */
                updateDetected();
                toast('已读入 ' + file.name);
            } catch (err) {
                toast('文件读取失败');
            }
        });

        /* 初始化:面板一打开就先显示"等待输入…" */
        updateDetected();
    },
};
