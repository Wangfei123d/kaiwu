// Cookie 串的构造与体检。纯函数,可直接 node --test。
//
// 为什么单独拿出来:这两件事都要能被单测钉住 ——
//   * 拼 Cookie 串时要跳过没有值的、重复名字的(Electron 会同时给出
//     `.douyin.com` 与 `www.douyin.com` 两条同名 Cookie,直接拼会重复)
//   * "这个 Cookie 够不够用"的判断(缺 uifid / sessionid)在界面、日志、
//     自检里都要一致,不能三处各写一套

/**
 * 把 Electron 的 Cookie 对象数组拼成请求头用的字符串。
 *
 * @param {Array<{name:string,value:string,domain?:string,path?:string}>} cookies
 * @returns {string} 形如 `a=1; b=2`
 */
export function buildCookieString(cookies) {
    const seen = new Map();
    for (const c of Array.isArray(cookies) ? cookies : []) {
        if (!c || typeof c.name !== 'string' || c.name === '') continue;
        if (typeof c.value !== 'string' || c.value === '') continue;
        const prev = seen.get(c.name);
        // 同名时优先保留更"具体"的那条:带点的域 Cookie(.douyin.com)是主域的,
        // 通常才是服务端真正要的;没有更具体信息就保留先来的。
        if (prev === undefined) {
            seen.set(c.name, c.value);
        } else if (typeof c.domain === 'string' && c.domain.startsWith('.')) {
            seen.set(c.name, c.value);
        }
    }
    return [...seen.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

/**
 * 体检一个 Cookie 串:长度、条数、以及几个关键字段在不在。
 *
 * ⚠️ 为什么专门看 uifid 和 sessionid:抖音的详情接口被风控挡着
 * (`403 Blocked by ArgusSecurityPlugin Uifid Not Found`),
 * 只有 ttwid 的 Cookie 是**一定**过不去的。界面要能直接说清"缺哪个",
 * 而不是丢一句"解析失败"让用户猜。
 *
 * @param {string} cookieStr
 * @returns {{length:number,count:number,names:string[],hasUifid:boolean,
 *            hasSessionid:boolean,hasTtwid:boolean,usable:boolean}}
 */
export function summarizeCookie(cookieStr) {
    const text = String(cookieStr ?? '');
    const names = text.split(';')
        .map(p => p.trim())
        .filter(p => p !== '')
        .map(p => p.slice(0, p.indexOf('=') === -1 ? undefined : p.indexOf('=')).trim())
        .filter(n => n !== '');
    const has = (n) => names.includes(n);
    const hasSessionid = names.some(n => n.startsWith('sessionid'));
    const hasUifid = has('uifid') || has('UIFID_TEMP');
    return {
        length: text.length,
        count: names.length,
        names,
        hasUifid,
        hasSessionid,
        hasTtwid: has('ttwid'),
        // "够用"= 有登录态或至少有风控要的 uifid。只判断够不够,
        // 不判断抖音那边最终认不认(那只有真请求才知道)。
        usable: hasSessionid && hasUifid,
    };
}
