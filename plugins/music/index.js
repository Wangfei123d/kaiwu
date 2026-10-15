import { toast } from 'toolbox://shell/lib/utils.js';
import { createServiceBadge } from 'toolbox://shell/shell/service-badge.js';

// 服务地址:端口必须与 plugin.json 里 qqmusic 的 port 一致。
const MUSIC_API = 'http://localhost:3300';
const SERVICE_ID = 'qqmusic';

export default {
    activate() {
        // 服务由 plugin.json 声明;状态订阅在 setup 里由共享徽标组件建立
        // (它需要面板里的容器元素,而 activate 阶段面板还不存在)。
        this.badge = null;
    },

    setup(el, ctx) {
        // 所有 DOM 引用都在这里才取 —— 面板此时已经注入(设计文档 §5.3)
        const keywordEl = el.querySelector('#musicKeyword');
        const searchBtn = el.querySelector('#musicSearchBtn');
        const listEl = el.querySelector('#musicList');
        const playerEl = el.querySelector('#musicPlayer');
        const coverEl = el.querySelector('#musicCover');
        const titleEl = el.querySelector('#musicTitle');
        const artistEl = el.querySelector('#musicArtist');
        const audioEl = el.querySelector('#musicAudio');
        const errorEl = el.querySelector('#musicError');

        // 服务状态徽标:与 douyin / bilibili 共用同一份组件。
        // 早先这里是自己写的一整套 DOM 操作,抽出去后三个插件只此一份实现。
        const badge = createServiceBadge({
            el: el.querySelector('#musicService'),
            ctx,
            serviceId: SERVICE_ID,
            hint: '点了「启动服务」才会开始搜索',
        });
        this.badge = badge;

        let playingItem = null;      // 记录正在播放的列表行,用于高亮

        /* ---- 秒数 → "分:秒" 显示 ---- */
        function formatTime(sec) {
            const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
            return m + ':' + String(s).padStart(2, '0');
        }

        /* ---- 统一请求封装 ---- */
        /* 把三类失败都转成能看懂的中文提示:
             1. fetch 直接抛异常 → 服务根本没启动
             2. code 2001        → 请求太频繁被限流
             3. 其他非 0 的 code  → 接口自己的业务错误 */
        async function musicFetch(url, options) {
            let res;
            try {
                res = await fetch(url, options);
            } catch {
                // 网络层失败,说明端口上没人监听。
                // 旧站这里让用户"去双击 start-music-api.bat";现在服务由应用托管,
                // 所以提示改成点上面的「启动服务」按钮。
                throw new Error('音乐服务未启动:点上方的「启动服务」按钮再试');
            }

            const json = await res.json();
            if (json.code === 2001) throw new Error('请求太频繁被限流了,请等几秒再试');
            if (json.code !== 0) throw new Error(json.message || '接口返回错误');

            return json.data;
        }

        /* ---- 歌手字段可能是字符串,也可能是对象数组,统一转成文字 ---- */
        function singerText(song) {
            if (Array.isArray(song.singer)) return song.singer.map(s => s.name).join(' / ');
            return song.singer || '未知歌手';
        }

        function showError(msg) {
            errorEl.textContent = msg;
            errorEl.classList.add('show');
        }

        function hideError() {
            errorEl.classList.remove('show');
        }

        /* ---- 搜索 ---- */
        async function searchMusic() {
            const keyword = keywordEl.value.trim();
            if (!keyword) return;

            hideError();
            listEl.innerHTML = '<li class="music-empty">搜索中…</li>';

            try {
                const data = await musicFetch(MUSIC_API + '/search/byType', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: 'keyword=' + encodeURIComponent(keyword) + '&type=0&num=20',
                });

                const songs = data?.body?.item_song ?? [];
                if (songs.length === 0) {
                    listEl.innerHTML = '<li class="music-empty">没有找到相关歌曲</li>';
                    return;
                }

                listEl.innerHTML = '';

                for (const song of songs) {
                    const li = document.createElement('li');
                    li.className = 'music-item';
                    // 先把四个 span 的结构摆好,再逐个用 textContent 填内容。
                    // 用 textContent 而不是 innerHTML:歌名里若带 < > 这类字符,
                    // 用 innerHTML 会被当成标签解析,页面结构就坏了。
                    li.innerHTML = '<span class="music-item-name"></span>'
                        + '<span class="music-item-singer"></span>'
                        + '<span class="music-item-album"></span>'
                        + '<span class="music-item-time"></span>';

                    li.querySelector('.music-item-name').textContent = song.name;
                    li.querySelector('.music-item-singer').textContent = singerText(song);
                    li.querySelector('.music-item-album').textContent = song.album?.name ?? '';
                    li.querySelector('.music-item-time').textContent =
                        song.interval ? formatTime(song.interval) : '';

                    li.addEventListener('click', () => playSong(song, li));
                    listEl.appendChild(li);
                }
            } catch (err) {
                listEl.innerHTML = '';
                const li = document.createElement('li');
                li.className = 'music-empty';
                li.textContent = err.message;
                listEl.appendChild(li);
            }
        }

        /* ---- 点歌播放 ---- */
        async function playSong(song, li) {
            hideError();

            try {
                // 先取消上一首的高亮,再点亮当前这首
                if (playingItem) playingItem.classList.remove('playing');
                li.classList.add('playing');
                playingItem = li;

                titleEl.textContent = song.name;
                artistEl.textContent = singerText(song)
                    + (song.album?.name ? ' · ' + song.album.name : '');

                // 封面用专辑 mid 直接拼官方 CDN 地址,省掉一次详情接口请求
                coverEl.src = 'https://y.gtimg.cn/music/photo_new/T002R300x300M000'
                    + (song.album?.mid ?? '') + '.jpg';
                playerEl.classList.add('show');

                // M500 = 128k MP3,匿名就能播;VIP 或无版权的歌这里拿不到直链
                const data = await musicFetch(
                    MUSIC_API + '/song/urls?mids=' + song.mid + '&type=M500');
                const url = data?.[song.mid]?.url;

                if (!url) throw new Error('这首歌需要 VIP 或无版权,换一首试试');

                audioEl.src = url;
                // 播放被浏览器拦截时静默忽略,不弹错误
                audioEl.play().catch(() => {});
            } catch (err) {
                li.classList.remove('playing');
                playingItem = null;
                showError(err.message);
            }
        }

        /* ---- 封面加载失败时换成占位图,不显示裂图 ---- */
        /* 直接把一小段 SVG 写成 data: URL 塞给 src,不用额外准备图片文件 */
        coverEl.addEventListener('error', () => {
            coverEl.src = 'data:image/svg+xml;utf8,' + encodeURIComponent(
                '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">'
                + '<rect width="100%" height="100%" fill="#2a2928"/>'
                + '<text x="50%" y="54%" fill="#6f6b66" font-size="12" '
                + 'text-anchor="middle">♪</text></svg>',
            );
        });

        /* ---- 音频加载失败(直链过期、CDN 拒绝等)给个可操作的提示 ---- */
        audioEl.addEventListener('error', () =>
            showError('音频加载失败,重新点一次这首歌试试'));

        /* ---- 事件绑定:按钮点击 + 输入框回车,两种都能搜 ---- */
        searchBtn.addEventListener('click', searchMusic);
        keywordEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') searchMusic();
        });
    },

    teardown() {
        this.badge?.dispose();
        this.badge = null;
    },
};
