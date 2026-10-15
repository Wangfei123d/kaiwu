/* ============================================================
   调色板 & 渐变 —— 插件入口(文件夹形态)
   ------------------------------------------------------------
   三块功能:
     ① 和谐配色生成 —— 一个主色算出五套配色方案
     ② CSS 渐变生成器 —— 调好渐变,输出能直接粘的 CSS
     ③ 从图片提取主色 —— 降采样 + 分桶统计,取出图片的主要颜色

   面板 HTML 在同目录的 panel.html,私有样式在 style.css,两者都由运行时读取后
   注入(样式会被自动加上 [data-plugin="palette"] 前缀,见设计文档 §6.4)。

   为什么所有 DOM 查询都在 setup(el, ctx) 里、并且一律限定在本面板内查询:
   面板要到用户第一次点开这个工具时才注入(设计文档 §5.3),在模块顶层写
   document.getElementById(...) 只会拿到 null —— 旧站的 tool-palette.js 正是
   那么写的,移植时必须改掉。原文件里模块顶层的三个立即渲染调用
   (renderSchemes / renderGradientStops / renderGradient)也一并挪到 setup 末尾。

   原文件从 tools-core.js 取的公共函数,现在改成从外壳公共库具名 import。
   ============================================================ */

import { toast, copyText, setupDropZone, loadImage, pickInk } from 'toolbox://shell/lib/utils.js';
import { hexToHsl, hexToRgb, hslToHex, rgbToHsl, rgbToHex } from 'toolbox://shell/lib/color.js';

export default {
    activate(ctx) {
        // 只注册贡献点,不碰 DOM —— 此时面板还没有注入(设计文档 §5.3)。
        //
        // 为什么 plugin.json 里已经声明了工具,这里还要再注册一次:
        // 当前运行时只把清单里的 contributes.services 登记进服务托管器,
        // contributes.tools 并不自动进 tools 注册表,而侧边栏与内容区都只读
        // 注册表(content.js 顶部的注释也这么写)。不注册的话,这个工具根本不会
        // 出现在侧边栏里。重复 id 会被注册表拒绝并返回 false(不抛错),
        // 所以将来运行时改成自动登记时,这次调用只会退化成一次无害的空操作。
        ctx.tools.register({
            id: 'palette',
            title: '调色板 & 渐变',
            icon: 'palette',
            order: 10,
            panel: 'panel.html',
            style: 'style.css',
        });
        ctx.log.info('调色板 & 渐变已就绪');
    },

    /* 首次打开该工具时调用:el 是已挂载的面板容器。 */
    setup(el) {
        /* ---- 面板里的元素全部在这里取,而且锁定在本面板内 ---- */
        const paletteBase = el.querySelector('#paletteBase');
        const paletteBaseHex = el.querySelector('#paletteBaseHex');
        const paletteSchemes = el.querySelector('#paletteSchemes');

        const gradientPreview = el.querySelector('#gradientPreview');
        const gradientCode = el.querySelector('#gradientCode');
        const gradientStops = el.querySelector('#gradientStops');
        const gradientType = el.querySelector('#gradientType');
        const gradientAngle = el.querySelector('#gradientAngle');
        const gradientAngleValue = el.querySelector('#gradientAngleValue');
        const gradientAngleField = el.querySelector('#gradientAngleField');
        const gradientAddStop = el.querySelector('#gradientAddStop');
        const gradientCopy = el.querySelector('#gradientCopy');

        const extractResult = el.querySelector('#extractResult');
        const extractDrop = el.querySelector('#extractDrop');
        const extractInput = el.querySelector('#extractInput');

        /* ============================================================
           ① 和谐配色生成
           ============================================================ */

        /* 五套配色方案,每套用 5 个"偏移量"描述。
           偏移量是 [色相偏移, 亮度偏移],施加在主色上就得到一个新颜色。

           为什么用偏移量而不是写死颜色?因为主色是用户随时会改的,
           写死的配色没法跟着变,偏移量则能保证任何主色都能算出一套来。 */
        const SCHEMES = [
            {
                name: '单色 —— 同一色相，五种深浅',
                offsets: [[0, -30], [0, -15], [0, 0], [0, 15], [0, 30]]
            },
            {
                name: '类似色 —— 色环上相邻的五个色相（±60°）',
                offsets: [[-60, 0], [-30, 0], [0, 0], [30, 0], [60, 0]]
            },
            {
                name: '互补色 —— 主色加上它对面 180° 的颜色',
                offsets: [[0, -15], [0, 0], [0, 15], [180, 0], [180, 15]]
            },
            {
                name: '分裂互补 —— 不用正对面，用对面两侧 ±30°，比互补色柔和',
                offsets: [[0, 0], [0, 20], [150, 0], [150, 15], [210, 0]]
            },
            {
                name: '三角色 —— 色环上等距的三个色相（相隔 120°）',
                offsets: [[0, 0], [0, 20], [120, 0], [240, 0], [240, 20]]
            }
        ];

        /* 亮度夹在 6~94 之间:太暗就是纯黑、太亮就是纯白,
           到了这两头色相和饱和度就没意义了,配色会看起来一片死黑或死白 */
        function clampLightness(l) {
            return Math.min(94, Math.max(6, l));
        }

        /* 饱和度同理,太低会变成灰,配色就没有色彩感了 */
        function clampSaturation(s) {
            return Math.min(100, Math.max(0, s));
        }

        /* 把 "#abc" / "abc" / "#aabbcc" 统一成 "#aabbcc";
           格式不对就返回 null,由调用处决定怎么处理 */
        function normalizeHex(value) {
            let v = (value || '').trim();
            if (!v) return null;
            if (!v.startsWith('#')) v = '#' + v;

            /* 三位简写补成六位 */
            if (/^#[0-9a-fA-F]{3}$/.test(v)) {
                v = '#' + v.slice(1).split('').map(c => c + c).join('');
            }

            return /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : null;
        }

        /* 造一个色块按钮 */
        function makeSwatch(hex) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'swatch';
            btn.style.background = hex;
            /* 把文字颜色写进 CSS 变量 --swatch-ink,
               样式表里 .swatch 的 color 读的就是它。
               这样深色底配白字、浅色底配黑字,任何颜色上都看得清 */
            btn.style.setProperty('--swatch-ink', pickInk(hex));
            btn.textContent = hex.toUpperCase();
            btn.title = '点击复制 ' + hex.toUpperCase();
            btn.addEventListener('click', () => copyText(hex.toUpperCase()));
            return btn;
        }

        /* 根据主色渲染出五套配色方案 */
        function renderSchemes(baseHex) {
            const base = hexToHsl(baseHex);

            paletteSchemes.textContent = '';    /* 清空重画(比 innerHTML = '' 更安全) */

            SCHEMES.forEach(scheme => {
                const group = document.createElement('div');
                group.className = 'scheme-group';

                const title = document.createElement('div');
                title.className = 'scheme-title';
                title.textContent = scheme.name;
                group.appendChild(title);

                const row = document.createElement('div');
                row.className = 'swatches';

                scheme.offsets.forEach(([hueOffset, lightOffset]) => {
                    const hex = hslToHex(
                        base.h + hueOffset,             /* hslToHex 内部会把色相归一化到 0-360 */
                        clampSaturation(base.s),
                        clampLightness(base.l + lightOffset)
                    );
                    row.appendChild(makeSwatch(hex));
                });

                group.appendChild(row);
                paletteSchemes.appendChild(group);
            });
        }

        /* 用户在取色器里选色 → 同步文本框 + 重画配色 */
        paletteBase.addEventListener('input', () => {
            paletteBaseHex.value = paletteBase.value;
            renderSchemes(paletteBase.value);
        });

        /* 用户手动输入色值 → 合法才同步取色器 + 重画
           不合法(比如打到一半的 "#7ec8")就先不动,不然会一直闪 */
        paletteBaseHex.addEventListener('input', () => {
            const hex = normalizeHex(paletteBaseHex.value);
            if (!hex) return;
            paletteBase.value = hex;
            renderSchemes(hex);
        });

        /* 输入框失焦时,把内容规整成标准格式回填 */
        paletteBaseHex.addEventListener('blur', () => {
            const hex = normalizeHex(paletteBaseHex.value);
            paletteBaseHex.value = hex ? hex.toUpperCase() : paletteBase.value.toUpperCase();
        });

        /* ============================================================
           ② CSS 渐变生成器
           ============================================================ */

        /* 渐变的全部状态都放在这个对象里。
           界面上任何改动都先改这个对象,再调 renderGradient() 重新画面,
           而不是去读 DOM 里现在的值。
           这种"状态 → 界面"单向流动的写法,比到处读 DOM 好维护得多。 */
        const gradientState = {
            type: 'linear',
            angle: 135,
            stops: [
                { color: '#7ec8ff', pos: 0 },
                { color: '#ff7ec8', pos: 100 }
            ]
        };

        /* 把状态拼成一段 CSS 值,比如:
           linear-gradient(135deg, #7ec8ff 0%, #ff7ec8 100%) */
        function buildGradientCSS() {
            /* 色标按位置排序,防止用户拖动后顺序乱了导致渐变出现硬边 */
            const stops = [...gradientState.stops]
                .sort((a, b) => a.pos - b.pos)
                .map(s => `${s.color} ${s.pos}%`)
                .join(', ');

            return gradientState.type === 'linear'
                ? `linear-gradient(${gradientState.angle}deg, ${stops})`
                : `radial-gradient(circle, ${stops})`;
        }

        /* 重画预览 + 代码框 */
        function renderGradient() {
            const css = buildGradientCSS();
            gradientPreview.style.background = css;
            gradientCode.value = 'background: ' + css + ';';
        }

        /* 重画色标列表(颜色选择器 + 位置滑块 + 删除按钮) */
        function renderGradientStops() {
            gradientStops.textContent = '';

            /* 至少要留 2 个色标才叫渐变,所以只有 2 个时禁用删除按钮 */
            const canRemove = gradientState.stops.length > 2;

            gradientState.stops.forEach((stop, index) => {
                const row = document.createElement('div');
                row.className = 'stop-row';

                /* --- 颜色选择器 --- */
                const color = document.createElement('input');
                color.type = 'color';
                color.value = stop.color;
                color.setAttribute('aria-label', `第 ${index + 1} 个色标的颜色`);
                color.addEventListener('input', () => {
                    stop.color = color.value;
                    renderGradient();
                });

                /* --- 位置滑块 --- */
                const range = document.createElement('input');
                range.type = 'range';
                range.min = 0;
                range.max = 100;
                range.value = stop.pos;
                range.setAttribute('aria-label', `第 ${index + 1} 个色标的位置`);
                range.addEventListener('input', () => {
                    stop.pos = Number(range.value);
                    label.textContent = stop.pos + '%';
                    /* 拖动位置时不重画整个列表(否则滑块会失去焦点,拖不动了),
                       但预览和代码要实时更新 */
                    renderGradient();
                });

                const label = document.createElement('span');
                label.className = 'stop-pos';
                label.textContent = stop.pos + '%';

                /* --- 删除按钮 --- */
                const remove = document.createElement('button');
                remove.type = 'button';
                remove.className = 'stop-remove';
                remove.textContent = '✕';
                remove.title = canRemove ? '删除这个色标' : '至少需要保留 2 个色标';
                remove.disabled = !canRemove;
                remove.addEventListener('click', () => {
                    gradientState.stops.splice(index, 1);
                    renderGradientStops();
                    renderGradient();
                });

                row.append(color, range, label, remove);
                gradientStops.appendChild(row);
            });
        }

        /* 两个颜色按比例混合 —— 新增色标时取两侧的中点色,
           这样插进去不会让渐变突然出现一道硬边 */
        function mixHex(hexA, hexB, ratio) {
            const a = hexToRgb(hexA);
            const b = hexToRgb(hexB);
            return rgbToHex(
                a.r + (b.r - a.r) * ratio,
                a.g + (b.g - a.g) * ratio,
                a.b + (b.b - a.b) * ratio
            );
        }

        /* 在"间隔最大"的那两个色标中间插一个新色标 */
        gradientAddStop.addEventListener('click', () => {
            if (gradientState.stops.length >= 6) {
                toast('最多 6 个色标');
                return;
            }

            const sorted = [...gradientState.stops].sort((a, b) => a.pos - b.pos);

            let widestGap = -1;
            let newPos = 50;
            let newColor = '#ffffff';

            for (let i = 0; i < sorted.length - 1; i++) {
                const gap = sorted[i + 1].pos - sorted[i].pos;
                if (gap > widestGap) {
                    widestGap = gap;
                    newPos = Math.round((sorted[i].pos + sorted[i + 1].pos) / 2);
                    newColor = mixHex(sorted[i].color, sorted[i + 1].color, 0.5);
                }
            }

            gradientState.stops.push({ color: newColor, pos: newPos });
            renderGradientStops();
            renderGradient();
        });

        /* 切换线性 / 径向:径向没有角度,把角度那一块整体藏掉 */
        gradientType.addEventListener('change', () => {
            gradientState.type = gradientType.value;
            gradientAngleField.style.visibility =
                gradientState.type === 'linear' ? 'visible' : 'hidden';
            renderGradient();
        });

        gradientAngle.addEventListener('input', () => {
            gradientState.angle = Number(gradientAngle.value);
            gradientAngleValue.textContent = gradientState.angle + '°';
            renderGradient();
        });

        gradientCopy.addEventListener('click', () => {
            copyText(gradientCode.value);
        });

        /* ============================================================
           ③ 从图片提取主色
           ------------------------------------------------------------
           思路是"降采样 + 分桶统计":
             1. 先把图片缩到 64×64 —— 颜色分布基本保留,但只剩 4096 个像素,
                处理起来飞快(原图几十万像素算起来没必要,还慢)
             2. 逐个像素转成 HSL,按"H 每 30° 一桶 / S 三档 / L 三档"扔进桶里
             3. 像素最多的 6 个桶,各取平均色就是主色

           这是简化版的做法。专业工具用的是"中位切分"等更精细的算法,
           但代码量是这个的好几倍,取主色这个场景用不上。 */

        const EXTRACT_SIZE = 64;

        function extractPalette(img) {
            /* 用一个临时 canvas 来读像素。
               局部变量叫 canvasCtx 而不是 ctx —— 本项目里 ctx 专指插件上下文,
               重名容易看错,也会在将来给 setup 加上 ctx 参数时被悄悄遮住。 */
            const canvas = document.createElement('canvas');
            canvas.width = EXTRACT_SIZE;
            canvas.height = EXTRACT_SIZE;

            const canvasCtx = canvas.getContext('2d');
            /* 把图片缩放画上去。drawImage 会自动做插值,
               所以这一步同时完成了"缩小"和"重采样" */
            canvasCtx.drawImage(img, 0, 0, EXTRACT_SIZE, EXTRACT_SIZE);

            /* getImageData 拿到的是一个扁平数组:
               每个像素占 4 个位置,依次是 R G B A,所以循环每次跳 4 步 */
            const { data } = canvasCtx.getImageData(0, 0, EXTRACT_SIZE, EXTRACT_SIZE);

            const buckets = new Map();
            let counted = 0;

            for (let i = 0; i < data.length; i += 4) {
                const r = data[i];
                const g = data[i + 1];
                const b = data[i + 2];
                const alpha = data[i + 3];

                /* 跳过透明像素(比如 PNG 的空白区域) */
                if (alpha < 128) continue;

                const { h, s, l } = rgbToHsl(r, g, b);

                /* 跳过近乎纯黑、纯白、纯灰的像素:
                   它们占了画面很大面积,但算不上"主色",
                   不排除的话提取结果永远是一片黑白灰 */
                if (l < 8 || l > 92 || s < 10) continue;

                const key = `${Math.floor(h / 30)}-${Math.floor(s / 34)}-${Math.floor(l / 34)}`;

                let bucket = buckets.get(key);
                if (!bucket) {
                    bucket = { count: 0, r: 0, g: 0, b: 0 };
                    buckets.set(key, bucket);
                }

                /* 累加每个通道的值,最后除以数量就是这一桶的平均色 */
                bucket.count++;
                bucket.r += r;
                bucket.g += g;
                bucket.b += b;
                counted++;
            }

            return [...buckets.values()]
                .sort((a, b) => b.count - a.count)   /* 像素多的排前面 */
                .slice(0, 6)
                .map(bucket => ({
                    hex: rgbToHex(bucket.r / bucket.count,
                                  bucket.g / bucket.count,
                                  bucket.b / bucket.count),
                    /* 占比:这个颜色占了多少画面,给用户一个直观参考 */
                    share: counted ? bucket.count / counted : 0
                }));
        }

        async function handleExtractFile(file) {
            if (!file.type.startsWith('image/')) {
                toast('请选择图片文件');
                return;
            }

            extractResult.textContent = '正在分析…';

            try {
                const img = await loadImage(file);
                const colors = extractPalette(img);

                extractResult.textContent = '';

                if (!colors.length) {
                    extractResult.textContent = '这张图里没找到明显的色彩（可能是纯黑白灰）';
                    extractResult.className = 'mt-md hint';
                    return;
                }

                extractResult.className = 'mt-md';

                const row = document.createElement('div');
                row.className = 'swatches';

                colors.forEach(({ hex, share }) => {
                    const btn = makeSwatch(hex);
                    /* 色块下面补一行占比 */
                    btn.title = `点击复制 ${hex.toUpperCase()}（约占画面 ${(share * 100).toFixed(1)}%）`;
                    const badge = document.createElement('span');
                    badge.textContent = (share * 100).toFixed(0) + '%';
                    badge.style.cssText = 'font-size:11px;opacity:.75;margin-left:6px';
                    btn.appendChild(badge);
                    row.appendChild(btn);
                });

                const caption = document.createElement('p');
                caption.className = 'hint mt-sm';
                caption.textContent = '点击色块即可复制。百分比是这个颜色在画面里的大致占比。';

                extractResult.append(row, caption);
            } catch (err) {
                extractResult.textContent = err.message;
                extractResult.className = 'mt-md hint';
            }
        }

        setupDropZone(extractDrop, extractInput, {
            multiple: false,
            onFiles: files => handleExtractFile(files[0])
        });

        /* ---- 面板刚注入,三块功能各先画一次 ---- */
        renderSchemes(paletteBase.value);
        renderGradientStops();
        renderGradient();
    },
};
