/* ============================================================
   通用小工具
   ------------------------------------------------------------
   toast / 复制 / 下载 / canvas 导出 / 字节格式化 / 拖拽上传区 / 读图 / 文字取色。

   这些是三个工具都要用的共用底座,所以抽到 lib 里,插件按需具名 import:
       import { toast, copyText } from 'toolbox://shell/lib/utils.js';

   本模块碰 DOM,因此不做单元测试 —— DOM 行为由自检(真实 Electron)覆盖。
   ============================================================ */

import { hexToRgb } from './color.js';

/* ---- 全局提示 ---- */
/* 用法: toast('已复制 #7ec8ff')
   效果:底部浮出一条提示,2 秒后自动消失 */

/* 惰性查找提示条元素:模块加载时 DOM 可能还没就绪,
   所以在模块顶层就 getElementById 是不行的;找不到就自己造一个挂到 body 上 */
function toastElement() {
    let el = document.getElementById('toast');
    if (!el) {
        el = document.createElement('div');
        el.id = 'toast';
        el.setAttribute('role', 'status');
        el.setAttribute('aria-live', 'polite');
        document.body.appendChild(el);
    }
    return el;
}

export function toast(message) {
    const el = toastElement();
    el.textContent = message;
    el.classList.add('show');

    /* 连续调用时先清掉上一次的计时器再重新计时,
       否则会出现"前一条的计时器把后一条提前关掉"的闪烁 */
    clearTimeout(el._timer);
    el._timer = setTimeout(() => el.classList.remove('show'), 2000);
}

/* ---- 复制到剪贴板 ---- */
/* 复制成功后弹提示。返回 Promise,调用处可以 await */
export async function copyText(text) {
    try {
        await navigator.clipboard.writeText(text);
    } catch (err) {
        /* 有些环境(旧的 http 页面、部分浏览器)不给用 clipboard API,
           退回到"建一个隐藏输入框 + 模拟 Ctrl+C"的老办法 */
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';      /* 别让它把页面撑出滚动条 */
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        textarea.remove();
    }
    toast('已复制 ' + text);
}

/* ---- 触发文件下载 ---- */
/* 原理:把数据包装成一个临时 URL,塞给一个带 download 属性的 <a> 点一下。
   用完必须 revokeObjectURL 释放,否则这块内存要等到页面关闭才回收。 */
export function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    /* 必须先插进文档再点击:Firefox 对脱离文档的元素不触发下载。
       点完立刻移除,不留痕迹 */
    document.body.appendChild(a);
    a.click();
    a.remove();
    /* 延迟释放:立刻 revoke 有可能让下载刚开始就断掉 */
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ---- 把 canvas 导出成 Blob ---- */
/* canvas.toBlob 是回调式的,包成 Promise 才好 await。
   图片处理和调色预演都要用,所以放在共用底座里,不各写一份。

   参数说明:
     type     输出格式,如 'image/webp' / 'image/jpeg' / 'image/png'
     quality  0~1 的质量。PNG 是无损格式,传了也会被浏览器忽略,
              所以统一在这里把它剔掉,调用处不用自己判断 */
export function canvasToBlob(canvas, type, quality) {
    return new Promise((resolve, reject) => {
        canvas.toBlob(
            blob => {
                /* 尺寸超出浏览器画布上限时 toBlob 会给回 null,
                   而不是抛异常,所以要自己检查 */
                if (blob) resolve(blob);
                else reject(new Error('这张图转换失败，可能是尺寸太大超出了浏览器限制'));
            },
            type,
            type === 'image/png' ? undefined : quality
        );
    });
}

/* ---- 字节数转成好读的格式 ---- */
/* 1024 → "1.0 KB", 1536000 → "1.5 MB" */
export function formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    const units = ['KB', 'MB', 'GB'];
    let value = bytes / 1024;
    let i = 0;
    while (value >= 1024 && i < units.length - 1) {
        value /= 1024;
        i++;
    }
    /* 数值越大保留越少的小数位,避免出现 "1023.87 MB" 这种啰嗦数字 */
    return value.toFixed(value >= 100 ? 0 : 1) + ' ' + units[i];
}

/* ---- 把一块区域变成"可拖拽 + 可点击选择文件"的上传区 ---- */
/* 调色板的图片取色、图片工具、字幕工具都用它,避免写三遍同样的拖拽逻辑。
   参数:
     zoneEl   显示"拖到这里"的那块区域
     inputEl  背后真正接收文件的 <input type="file">
     multiple 是否允许一次拖多个文件
     onFiles  拿到文件后要做的事,收到的是文件数组 */
export function setupDropZone(zoneEl, inputEl, { multiple = false, onFiles }) {
    /* 点击整块区域等于点击那个隐藏的 input */
    zoneEl.addEventListener('click', () => inputEl.click());

    inputEl.addEventListener('change', () => {
        if (inputEl.files.length) onFiles([...inputEl.files]);
        /* 处理完立刻清空 input 的值,
           否则连着选两次同一个文件时第二次不会触发 change 事件 */
        inputEl.value = '';
    });

    /* 浏览器默认会把拖进来的文件"打开"(比如直接跳走显示图片),
       必须阻止这个默认行为,才能自己接管 */
    ['dragenter', 'dragover'].forEach(type => {
        zoneEl.addEventListener(type, e => {
            e.preventDefault();
            zoneEl.classList.add('dragover');
        });
    });

    ['dragleave', 'drop'].forEach(type => {
        zoneEl.addEventListener(type, e => {
            e.preventDefault();
            zoneEl.classList.remove('dragover');
        });
    });

    zoneEl.addEventListener('drop', e => {
        const files = [...(e.dataTransfer?.files || [])];
        if (files.length) onFiles(multiple ? files : files.slice(0, 1));
    });
}

/* ---- 把文件读成 <img> 对象 ---- */
/* 返回 Promise,所以可以 await loadImage(file) 拿到加载完的图片。
   用 objectURL 而不是 FileReader:不用把整个文件读成 base64 字符串,
   大图能省下大量内存。 */
export function loadImage(file) {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => {
            URL.revokeObjectURL(url);   /* 图片已经解码进 img 了,URL 可以释放 */
            resolve(img);
        };
        img.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error('这张图片读不出来，可能格式不支持或文件已损坏'));
        };
        img.src = url;
    });
}

/* ---- 按底色亮度决定色块上的文字用黑还是白 ---- */
/* 这是 WCAG 里算"相对亮度"的简化版:
   人眼对绿最敏感、红次之、蓝最不敏感,所以按 0.299/0.587/0.114 加权 */
export function pickInk(hex) {
    const { r, g, b } = hexToRgb(hex);
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return luminance > 0.6 ? '#1a1919' : '#ffffff';
}
