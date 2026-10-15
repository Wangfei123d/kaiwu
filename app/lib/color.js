/* ============================================================
   颜色转换函数
   ------------------------------------------------------------
   HEX(#7ec8ff) 和 HSL(色相/饱和度/亮度) 之间的互转。

   为什么配色算法要用 HSL 而不是 RGB?
   因为 RGB 里三个通道是"光的强度",改一个数字颜色就面目全非;
   而 HSL 是按人理解颜色的方式拆开的:
     H 色相(Hue)        0-360°,就是色环上的角度。0=红 120=绿 240=蓝
     S 饱和度(Saturation) 0-100%,0 是灰色,100 是最鲜艳
     L 亮度(Lightness)   0-100%,0 是黑,50 是纯色,100 是白
   所以"把颜色转个 180 度变成互补色"这种事,在 HSL 里就是 H + 180,
   在 RGB 里则完全没法直接算。

   纯模块:不碰 DOM、不碰 Node 专属 API,所以可以直接在 node --test 里跑。
   ============================================================ */

/* #7ec8ff → { r: 126, g: 200, b: 255 } */
export function hexToRgb(hex) {
    let h = hex.replace('#', '').trim();

    /* 支持简写:#abc 等价于 #aabbcc */
    if (h.length === 3) {
        h = h.split('').map(c => c + c).join('');
    }

    const n = parseInt(h, 16);
    return {
        r: (n >> 16) & 255,     /* 高 8 位是红 */
        g: (n >> 8) & 255,      /* 中间 8 位是绿 */
        b: n & 255              /* 低 8 位是蓝 */
    };
}

/* (126, 200, 255) → "#7ec8ff" */
export function rgbToHex(r, g, b) {
    /* 四舍五入并夹到 0-255,防止浮点误差算出 -1 或 256 变成乱码 */
    const to2 = v => Math.round(Math.min(255, Math.max(0, v)))
                          .toString(16)
                          .padStart(2, '0');    /* 不足两位前面补 0: 15 → "0f" */
    return '#' + to2(r) + to2(g) + to2(b);
}

/* (126, 200, 255) → { h: 205, s: 80, l: 75 } */
export function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;               /* 先归一化到 0-1 */

    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;                  /* 亮度 = 最亮和最暗的平均 */
    const d = max - min;                        /* 差值越大颜色越鲜艳 */

    let h = 0, s = 0;

    if (d !== 0) {                              /* 差值 0 说明是灰色,没有色相 */
        /* 饱和度公式分两段:亮色的饱和度被"离白"的距离限制,暗色被"离黑"的距离限制 */
        s = l > .5 ? d / (2 - max - min) : d / (max + min);

        /* 看哪个通道最大,就知道色相落在色环的哪一段 60° 区间里 */
        switch (max) {
            case r: h = (g - b) / d + (g < b ? 6 : 0); break;
            case g: h = (b - r) / d + 2; break;
            default: h = (r - g) / d + 4;
        }
        h *= 60;                                /* 换算成 0-360 度 */
    }

    return { h, s: s * 100, l: l * 100 };
}

/* { h: 205, s: 80, l: 75 } → { r: 126, g: 200, b: 255 } */
export function hslToRgb(h, s, l) {
    /* 归一化色相到 0-360。
       注意 JS 里负数取模结果还是负数(-30 % 360 === -30),
       所以要再加一次 360 再取模,这是最容易踩的坑 */
    h = ((h % 360) + 360) % 360;
    s /= 100;
    l /= 100;

    const c = (1 - Math.abs(2 * l - 1)) * s;                /* 色度:颜色的"浓度" */
    const x = c * (1 - Math.abs((h / 60) % 2 - 1));         /* 色环上相邻两色的过渡值 */
    const m = l - c / 2;                                    /* 让整体亮起或暗下去 */

    /* 把色环按 60° 分成六段,每段的 RGB 组合是固定的 */
    let r = 0, g = 0, b = 0;
    if (h < 60)       { r = c; g = x; }
    else if (h < 120) { r = x; g = c; }
    else if (h < 180) { g = c; b = x; }
    else if (h < 240) { g = x; b = c; }
    else if (h < 300) { r = x; b = c; }
    else              { r = c; b = x; }

    return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 };
}

/* 上面四个函数的便捷组合,调色板工具里用得最多 */
export function hexToHsl(hex) {
    const { r, g, b } = hexToRgb(hex);
    return rgbToHsl(r, g, b);
}

export function hslToHex(h, s, l) {
    const { r, g, b } = hslToRgb(h, s, l);
    return rgbToHex(r, g, b);
}
