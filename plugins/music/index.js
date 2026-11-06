import { toast } from 'toolbox://shell/lib/utils.js';

// 服务地址:端口必须与 plugin.json 里 qqmusic 的 port 一致。
const MUSIC_API = 'http://localhost:3300';
const SERVICE_ID = 'qqmusic';
const QUALITY_OPTIONS = [
    { value: 'M500', label: '标准 · MP3 128 kbps', compact: 'MP3 128' },
    { value: 'M800', label: '高品 · MP3 320 kbps', compact: 'MP3 320' },
    { value: 'F000', label: '无损 · FLAC', compact: 'FLAC' },
    { value: 'AI00', label: '臻品 · 母带', compact: '母带' },
    { value: 'C600', label: '高品 · AAC 192 kbps', compact: 'AAC 192' },
];
const QUALITY_STORAGE_KEY = 'kaiwu.music.playQuality';
const DEFAULT_QUALITY = 'M500';

export default {
    activate() {},

    setup(el, ctx) {
        this.panelCleanup?.();
        this.panelCleanup = null;

        // 所有 DOM 引用都在这里才取 —— 面板此时已经注入(设计文档 §5.3)
        const keywordEl = el.querySelector('#musicKeyword');
        const listEl = el.querySelector('#musicList');
        const playerEl = el.querySelector('#musicPlayer');
        const coverEl = el.querySelector('#musicCover');
        const titleEl = el.querySelector('#musicTitle');
        const artistEl = el.querySelector('#musicArtist');
        const audioEl = el.querySelector('#musicAudio');
        const seekEl = el.querySelector('#musicSeek');
        const currentTimeEl = el.querySelector('#musicCurrentTime');
        const durationEl = el.querySelector('#musicDuration');
        const playToggleButton = el.querySelector('#musicPlayToggle');
        const downloadCurrentButton = el.querySelector('#musicDownloadCurrent');
        const errorEl = el.querySelector('#musicError');
        const accountEl = el.querySelector('#musicAccount');
        const accountStatusEl = el.querySelector('#musicAccountStatus');
        const loginButton = el.querySelector('#musicLoginButton');
        const loginDialog = el.querySelector('#musicLoginDialog');
        const loginQrEl = el.querySelector('#musicLoginQr');
        const qrPlaceholderEl = el.querySelector('#musicQrPlaceholder');
        const qrStatusEl = el.querySelector('#musicQrStatus');
        const loginMessageEl = el.querySelector('#musicLoginMessage');
        const qrRefreshButton = el.querySelector('#musicQrRefresh');
        const loginCloseButton = el.querySelector('#musicLoginClose');
        const loginDoneButton = el.querySelector('#musicLoginDone');
        const qualityEl = el.querySelector('#musicQuality');
        const qualityControlEl = el.querySelector('#musicQualityControl');
        const qualityButton = el.querySelector('#musicQualityButton');
        const qualityLabelEl = el.querySelector('#musicQualityLabel');
        const qualityMenu = el.querySelector('#musicQualityMenu');

        let playingItem = null;      // 记录正在播放的列表行,用于高亮
        let selectedSong = null;
        let downloadInFlight = false;
        let playRequestSequence = 0;
        let activePlayback = null;
        let qrIdentifier = null;
        let qrPollTimer = null;
        let qrTimeoutTimer = null;
        let qrCloseTimer = null;
        let qrPollInFlight = false;
        let qrGeneration = 0;
        let accountStatusRequest = 0;
        let disposed = false;
        const listeners = new AbortController();
        const listen = (target, eventName, handler, options = {}) => {
            target.addEventListener(eventName, handler, { ...options, signal: listeners.signal });
        };

        const readQualityPreference = () => {
            try {
                const saved = localStorage.getItem(QUALITY_STORAGE_KEY);
                return QUALITY_OPTIONS.some((option) => option.value === saved) ? saved : DEFAULT_QUALITY;
            } catch {
                return DEFAULT_QUALITY;
            }
        };
        qualityEl.value = readQualityPreference();

        const qualityOptions = QUALITY_OPTIONS.map((option) => {
            const [tier, description] = option.label.split(' · ');
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'music-quality-option';
            item.dataset.value = option.value;
            item.setAttribute('role', 'option');
            item.tabIndex = -1;
            const copy = document.createElement('span');
            copy.className = 'music-quality-copy';
            const tierLabel = document.createElement('span');
            tierLabel.className = 'music-quality-tier';
            tierLabel.textContent = tier;
            const detail = document.createElement('span');
            detail.className = 'music-quality-detail';
            detail.textContent = description;
            const check = document.createElement('span');
            check.className = 'music-quality-check';
            check.setAttribute('aria-hidden', 'true');
            check.textContent = '✓';
            copy.append(tierLabel, detail);
            item.append(copy, check);
            item.addEventListener('click', () => chooseQuality(option.value));
            qualityMenu.appendChild(item);
            return item;
        });

        function syncQualityMenu() {
            const selected = QUALITY_OPTIONS.find((option) => option.value === qualityEl.value) ?? QUALITY_OPTIONS[0];
            qualityLabelEl.textContent = selected.compact;
            qualityButton.title = selected.label;
            for (const item of qualityOptions) {
                const active = item.dataset.value === selected.value;
                item.classList.toggle('selected', active);
                item.setAttribute('aria-selected', String(active));
            }
        }

        function closeQualityMenu({ restoreFocus = false } = {}) {
            qualityMenu.hidden = true;
            qualityControlEl.classList.remove('open');
            qualityButton.setAttribute('aria-expanded', 'false');
            if (restoreFocus) qualityButton.focus();
        }

        function openQualityMenu({ focusSelected = true } = {}) {
            qualityMenu.hidden = false;
            qualityControlEl.classList.add('open');
            qualityButton.setAttribute('aria-expanded', 'true');
            if (focusSelected) qualityOptions.find((item) => item.dataset.value === qualityEl.value)?.focus();
        }

        function chooseQuality(value) {
            if (!QUALITY_OPTIONS.some((option) => option.value === value)) return;
            if (qualityEl.value !== value) {
                qualityLabelEl.classList.remove('is-changing');
                void qualityLabelEl.offsetWidth;
                qualityLabelEl.classList.add('is-changing');
                setTimeout(() => qualityLabelEl.classList.remove('is-changing'), 300);
            }
            qualityEl.value = value;
            qualityEl.dispatchEvent(new Event('change', { bubbles: true }));
            syncQualityMenu();
            closeQualityMenu({ restoreFocus: true });
        }

        syncQualityMenu();

        listen(qualityButton, 'click', () => {
            if (qualityMenu.hidden) openQualityMenu();
            else closeQualityMenu();
        });
        listen(qualityButton, 'keydown', (event) => {
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
            event.preventDefault();
            openQualityMenu();
        });
        listen(qualityMenu, 'keydown', (event) => {
            const index = qualityOptions.indexOf(document.activeElement);
            if (event.key === 'Escape') {
                event.preventDefault();
                closeQualityMenu({ restoreFocus: true });
                return;
            }
            if (event.key === 'Tab') { closeQualityMenu(); return; }
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                const active = qualityOptions[index];
                if (active) chooseQuality(active.dataset.value);
                return;
            }
            let next = index;
            if (event.key === 'ArrowDown') next = (index + 1 + qualityOptions.length) % qualityOptions.length;
            else if (event.key === 'ArrowUp') next = (index - 1 + qualityOptions.length) % qualityOptions.length;
            else if (event.key === 'Home') next = 0;
            else if (event.key === 'End') next = qualityOptions.length - 1;
            else return;
            event.preventDefault();
            qualityOptions[next]?.focus();
        });
        listen(document, 'pointerdown', (event) => {
            if (!qualityControlEl.contains(event.target)) closeQualityMenu();
        }, { capture: true });

        /* ---- 秒数 → "分:秒" 显示 ---- */
        function formatTime(sec) {
            const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
            return m + ':' + String(s).padStart(2, '0');
        }

        function updatePlaybackControls() {
            const duration = Number.isFinite(audioEl.duration) && audioEl.duration > 0 ? audioEl.duration : 0;
            const currentTime = Number.isFinite(audioEl.currentTime) && audioEl.currentTime > 0
                ? Math.min(audioEl.currentTime, duration || audioEl.currentTime)
                : 0;
            const currentText = formatTime(currentTime);
            const durationText = formatTime(duration);
            const isPlaying = !audioEl.paused && !audioEl.ended;
            const progress = duration ? Math.round(currentTime / duration * 1000) : 0;

            currentTimeEl.textContent = currentText;
            durationEl.textContent = durationText;
            seekEl.value = String(progress);
            seekEl.style.setProperty('--progress', `${progress / 10}%`);
            seekEl.disabled = !duration;
            seekEl.setAttribute('aria-valuetext', `${currentText} / ${durationText}`);
            playToggleButton.dataset.playing = String(isPlaying);
            playToggleButton.setAttribute('aria-label', isPlaying ? '暂停' : '播放');
            playToggleButton.title = isPlaying ? '暂停' : '播放';
        }

        /* ---- 统一请求封装 ---- */
        /* 把三类失败都转成能看懂的中文提示:
             1. fetch 直接抛异常 → 服务根本没启动
             2. code 2001        → 请求太频繁被限流
             3. 其他非 0 的 code  → 接口自己的业务错误 */
        async function musicFetch(url, options, selectData = (data) => data) {
            let res;
            try {
                res = await fetch(url, options);
            } catch {
                // TypeError: Failed to fetch 既可能是端口未监听,也可能是浏览器拦截了跨域请求。
                // 不把这两种情况都误报成「服务未启动」。
                throw new Error('无法连接音乐接口，请确认服务运行状态与跨域配置。');
            }

            const json = await res.json();
            if (json.code === 2001) throw new Error('请求太频繁被限流了,请等几秒再试');
            if (json.code !== 0) throw new Error(json.message || '接口返回错误');

            return selectData(json.data);
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

        function setAccountStatus(state, message) {
            accountEl.dataset.state = state;
            accountStatusEl.textContent = message;
            loginButton.textContent = '账号';
            loginButton.setAttribute('aria-label', state === 'logged-in' ? '管理音乐账号' : '音乐账号登录');
            loginButton.title = message;
        }

        async function refreshAccountStatus() {
            if (disposed) return false;
            const request = ++accountStatusRequest;
            try {
                const status = await musicFetch(MUSIC_API + '/login/status');
                if (disposed || request !== accountStatusRequest) return null;
                if (status?.loggedIn === true && status?.expired !== true) {
                    setAccountStatus('logged-in', '已登录');
                    return true;
                }
                if (status?.loggedIn === true && status?.expired === true) {
                    setAccountStatus('expired', '登录凭证已过期，请重新扫码');
                    return false;
                }
                setAccountStatus('logged-out', '未登录');
                return false;
            } catch (err) {
                if (disposed || request !== accountStatusRequest) return null;
                setAccountStatus('error', err.message === '无法连接音乐接口，请确认服务运行状态与跨域配置。'
                    ? '音乐服务未连接'
                    : '暂时无法读取登录状态');
                return false;
            }
        }

        function setQrStatus(message, kind = '') {
            qrStatusEl.textContent = message;
            if (kind) qrStatusEl.dataset.kind = kind;
            else delete qrStatusEl.dataset.kind;
        }

        function stopQrPolling() {
            if (qrPollTimer !== null) clearInterval(qrPollTimer);
            if (qrTimeoutTimer !== null) clearTimeout(qrTimeoutTimer);
            qrPollTimer = null;
            qrTimeoutTimer = null;
            qrIdentifier = null;
        }

        function closeLoginDialog() {
            qrGeneration += 1;
            stopQrPolling();
            if (qrCloseTimer !== null) clearTimeout(qrCloseTimer);
            qrCloseTimer = null;
            loginDialog.hidden = true;
            loginQrEl.removeAttribute('src');
            loginQrEl.hidden = true;
            qrPlaceholderEl.hidden = false;
            qrPlaceholderEl.textContent = '点击“刷新二维码”生成二维码';
            qrRefreshButton.disabled = false;
            if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
        }

        async function pollLoginQr(identifier) {
            if (qrPollInFlight || identifier !== qrIdentifier || disposed) return;
            const generation = qrGeneration;
            qrPollInFlight = true;
            try {
                // checkQrcode 返回的凭证不进入面板状态；这里只取二维码事件码。
                const result = await musicFetch(MUSIC_API + '/login/checkQrcode', {
                    method: 'POST',
                    // application/json 会触发浏览器 OPTIONS 预检;QQMusicapi 的本地 CORS
                    // 中间件只放行 Origin,不处理预检。表单请求属于简单请求,无需预检。
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams({ identifier, type: 'qq' }).toString(),
                }, (data) => ({ event: data?.event }));
                if (identifier !== qrIdentifier) return;

                switch (Number(result?.event)) {
                    case 0: { // DONE
                        stopQrPolling();
                        setQrStatus('登录完成，正在更新账号状态…');
                let loggedIn = await refreshAccountStatus();
                if (loggedIn === null && !disposed && generation === qrGeneration && !loginDialog.hidden) {
                    loggedIn = await refreshAccountStatus();
                }
                        if (disposed || generation !== qrGeneration || loginDialog.hidden) return;
                        if (loggedIn === true) {
                            setQrStatus('已成功登录 QQ 音乐', 'success');
                            qrCloseTimer = setTimeout(() => {
                                qrCloseTimer = null;
                                if (!disposed && generation === qrGeneration) closeLoginDialog();
                            }, 900);
                        } else if (loggedIn === false) {
                            setQrStatus('服务已完成扫码，但登录状态暂未确认，请稍后重试。', 'error');
                            qrRefreshButton.disabled = false;
                        }
                        break;
                    }
                    case 1: // SCAN
                        setQrStatus('已扫码，请在手机上确认登录');
                        break;
                    case 2: // CONF
                        setQrStatus('正在确认登录…');
                        break;
                    case 3: // REFUSE
                        stopQrPolling();
                        setQrStatus('你已取消本次登录，可刷新二维码重试。', 'error');
                        qrRefreshButton.disabled = false;
                        break;
                    case 4: // TIMEOUT
                        stopQrPolling();
                        setQrStatus('二维码已过期，请刷新后重试。', 'error');
                        qrRefreshButton.disabled = false;
                        break;
                    default:
                        setQrStatus('等待扫码…');
                }
            } catch (err) {
                if (identifier !== qrIdentifier) return;
                stopQrPolling();
                setQrStatus(err.message, 'error');
                qrRefreshButton.disabled = false;
            } finally {
                qrPollInFlight = false;
            }
        }

        async function startQrLogin() {
            const generation = ++qrGeneration;
            stopQrPolling();
            loginDialog.hidden = false;
            loginMessageEl.textContent = accountEl.dataset.state === 'logged-in'
                ? '扫码后将切换本地 QQMusicapi 的登录账号。'
                : '请使用已开通会员的 QQ 音乐账号扫码。';
            loginQrEl.removeAttribute('src');
            loginQrEl.hidden = true;
            qrPlaceholderEl.hidden = false;
            qrPlaceholderEl.textContent = '正在生成二维码…';
            setQrStatus('正在连接本地音乐服务…');
            qrRefreshButton.disabled = true;

            try {
                const qr = await musicFetch(MUSIC_API + '/login/qrcode', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams({ type: 'qq' }).toString(),
                });
                if (disposed || generation !== qrGeneration || loginDialog.hidden) return;
                if (!qr?.identifier || !qr?.data || !['image/png', 'image/jpeg', 'image/gif'].includes(qr.mime)) {
                    throw new Error('音乐服务没有返回有效的登录二维码');
                }
                qrIdentifier = String(qr.identifier);
                loginQrEl.src = `data:${qr.mime};base64,${qr.data}`;
                loginQrEl.hidden = false;
                qrPlaceholderEl.hidden = true;
                setQrStatus('等待扫码…');
                qrRefreshButton.disabled = false;

                const identifier = qrIdentifier;
                qrPollTimer = setInterval(() => { void pollLoginQr(identifier); }, 1800);
                qrTimeoutTimer = setTimeout(() => {
                    if (identifier !== qrIdentifier || generation !== qrGeneration) return;
                    stopQrPolling();
                    setQrStatus('二维码已过期，请刷新后重试。', 'error');
                    qrRefreshButton.disabled = false;
                }, 120000);
            } catch (err) {
                if (disposed || generation !== qrGeneration || loginDialog.hidden) return;
                qrPlaceholderEl.textContent = '二维码暂不可用';
                setQrStatus(err.message, 'error');
                qrRefreshButton.disabled = false;
            }
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

                    const downloadButton = document.createElement('button');
                    downloadButton.type = 'button';
                    downloadButton.className = 'music-download-button music-item-download';
                    downloadButton.setAttribute('aria-label', `下载《${song.name}》`);
                    downloadButton.title = '下载歌曲';
                    downloadButton.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5v7m-3-3 3 3 3-3M3 11.5v2h10v-2"></path></svg>';
                    downloadButton.addEventListener('click', (event) => {
                        event.stopPropagation();
                        void downloadSong(song, downloadButton);
                    });
                    li.appendChild(downloadButton);

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

        function playbackQualities(preferred) {
            const fallback = preferred === 'AI00' || preferred === 'F000'
                ? ['M800', 'M500', 'C600']
                : preferred === 'C600'
                    ? ['M500', 'M800']
                    : preferred === 'M800'
                        ? ['M500', 'C600']
                        : ['M800', 'C600'];
            return [...new Set([preferred, ...fallback])];
        }

        function secureMediaUrl(rawUrl) {
            if (typeof rawUrl !== 'string' || !rawUrl) return '';
            try {
                const url = new URL(rawUrl);
                // QQMusicapi 当前返回的 CDN 地址是 HTTP；开物 CSP 只允许 HTTPS 媒体。
                // QQ 的 CDN 支持 HTTPS，用同一签名参数升级协议即可避免 CSP 拦截。
                const trustedCdn = url.hostname === 'qq.com' || url.hostname.endsWith('.qq.com')
                    || url.hostname === 'gtimg.cn' || url.hostname.endsWith('.gtimg.cn');
                if (url.protocol === 'http:' && trustedCdn) {
                    url.protocol = 'https:';
                }
                return url.protocol === 'https:' && trustedCdn ? url.href : '';
            } catch {
                return '';
            }
        }

        async function tryPlaybackQuality(playback, startIndex = 0) {
            if (playback.retryInFlight || disposed || playback.request !== playRequestSequence) return;
            playback.retryInFlight = true;
            try {
                for (let index = startIndex; index < playback.qualities.length; index += 1) {
                    if (disposed || playback.request !== playRequestSequence) return;
                    playback.qualityIndex = index;
                    const quality = playback.qualities[index];
                    let data;
                    try {
                        data = await musicFetch(MUSIC_API + '/song/urls?mids='
                            + encodeURIComponent(playback.song.mid) + '&type=' + encodeURIComponent(quality));
                    } catch (err) {
                        if (disposed || playback.request !== playRequestSequence) return;
                        if (playingItem) playingItem.classList.remove('playing');
                        playingItem = null;
                        activePlayback = null;
                        showError(err.message);
                        return;
                    }

                    if (disposed || playback.request !== playRequestSequence) return;
                    const url = secureMediaUrl(data?.[playback.song.mid]?.url);
                    if (!url) {
                        continue;
                    }

                    playback.url = url;
                    audioEl.src = url;
                    audioEl.load();
                    try {
                        await audioEl.play();
                        if (index > 0) showError(`所选音质暂不可用，已自动切换到 ${QUALITY_OPTIONS.find((item) => item.value === quality)?.label || quality}`);
                        return;
                    } catch (err) {
                        if (disposed || playback.request !== playRequestSequence) return;
                        if (err?.name === 'AbortError') return;
                        if (err?.name === 'NotAllowedError') {
                            showError('浏览器阻止了自动播放，请点击播放器中的播放按钮。');
                            return;
                        }
                    }
                }

                if (disposed || playback.request !== playRequestSequence) return;
                if (playingItem) playingItem.classList.remove('playing');
                playingItem = null;
                activePlayback = null;
                const mediaCode = audioEl.error?.code;
                const reason = mediaCode === 4
                    ? '音频格式或播放地址不受支持'
                    : mediaCode === 3
                        ? '音频解码失败'
                        : '音乐服务器拒绝了播放请求或链接已失效';
                showError(`${reason}。已尝试兼容音质，请换一首歌或稍后重试。`);
            } finally {
                playback.retryInFlight = false;
            }
        }

        /* ---- 点歌播放 ---- */
        async function playSong(song, li) {
            hideError();
            selectedSong = song;
            downloadCurrentButton.disabled = false;
            const request = ++playRequestSequence;
            const preferred = QUALITY_OPTIONS.some((option) => option.value === qualityEl.value)
                ? qualityEl.value
                : DEFAULT_QUALITY;

            try {
                if (playingItem) playingItem.classList.remove('playing');
                audioEl.pause();
                audioEl.removeAttribute('src');
                audioEl.load();
                li.classList.add('playing');
                playingItem = li;
                titleEl.textContent = song.name;
                artistEl.textContent = singerText(song)
                    + (song.album?.name ? ' · ' + song.album.name : '');
                coverEl.src = 'https://y.gtimg.cn/music/photo_new/T002R300x300M000'
                    + (song.album?.mid ?? '') + '.jpg';
                playerEl.classList.add('show');

                const playback = {
                    song,
                    request,
                    qualities: playbackQualities(preferred),
                    qualityIndex: -1,
                    retryInFlight: false,
                    url: null,
                };
                activePlayback = playback;
                await tryPlaybackQuality(playback);
            } catch (err) {
                if (disposed || request !== playRequestSequence) return;
                li.classList.remove('playing');
                playingItem = null;
                activePlayback = null;
                showError(err.message);
            }
        }

        async function downloadSong(song, button) {
            if (downloadInFlight) {
                toast('正在下载另一首歌曲，请稍候。');
                return;
            }
            hideError();
            downloadInFlight = true;
            button.disabled = true;
            button.classList.add('downloading');
            button.title = '正在下载…';
            try {
                const quality = QUALITY_OPTIONS.some((option) => option.value === qualityEl.value)
                    ? qualityEl.value : DEFAULT_QUALITY;
                const data = await musicFetch(MUSIC_API + '/song/urls?mids='
                    + encodeURIComponent(song.mid) + '&type=' + encodeURIComponent(quality));
                const url = secureMediaUrl(data?.[song.mid]?.url);
                if (!url) throw new Error('所选音质暂时没有可下载的音频地址');
                const extension = ({ M500: 'mp3', M800: 'mp3', F000: 'flac', AI00: 'flac', C600: 'm4a' })[quality] ?? 'mp3';
                const safeTitle = String(song.name ?? '歌曲').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').trim() || '歌曲';
                const result = await ctx.dialog.downloadMusic(url, {
                    fileName: `${safeTitle}.${extension}`,
                    extension,
                });
                if (result?.canceled) toast('已取消下载。');
                else if (result?.ok) toast(`已下载：${safeTitle}.${extension}`);
                else throw new Error(result?.error || '歌曲下载失败，请稍后重试。');
            } catch (error) {
                if (disposed) return;
                showError(error.message || '歌曲下载失败，请稍后重试。');
            } finally {
                downloadInFlight = false;
                button.disabled = false;
                button.classList.remove('downloading');
                button.title = button === downloadCurrentButton ? '下载当前歌曲' : '下载歌曲';
            }
        }

        let previousFocus = null;

        function handleServiceState(state) {
            if (disposed || !state) return;
            if (state.status === 'ready' || state.status === 'external') {
                void refreshAccountStatus();
            } else if (state.status === 'stopped' || state.status === 'failed') {
                accountStatusRequest += 1;
                setAccountStatus('error', '音乐服务未连接');
            } else if (state.status === 'starting') {
                setAccountStatus('error', '音乐服务启动中…');
            }
        }

        async function ensureMusicService() {
            try {
                const state = await ctx.services.status(SERVICE_ID);
                if (disposed) return;
                if (!state) throw new Error('服务未在插件清单中注册');
                if (state.status === 'ready' || state.status === 'external' || state.status === 'starting') {
                    handleServiceState(state);
                    return;
                }

                setAccountStatus('error', '音乐服务启动中…');
                const started = await ctx.services.start(SERVICE_ID);
                if (!disposed) handleServiceState(started);
            } catch (err) {
                if (disposed) return;
                ctx.log.error('音乐面板已打开,但服务自动启动失败', err);
                setAccountStatus('error', '音乐服务启动失败');
            }
        }

        const offServiceChange = ctx.services.on(SERVICE_ID, 'change', handleServiceState);
        void ensureMusicService();

        listen(loginButton, 'click', () => {
            previousFocus = document.activeElement;
            void startQrLogin();
            loginCloseButton.focus();
        });
        listen(qrRefreshButton, 'click', () => { void startQrLogin(); });
        listen(loginCloseButton, 'click', closeLoginDialog);
        listen(loginDoneButton, 'click', closeLoginDialog);
        listen(loginDialog, 'click', (event) => {
            if (event.target === loginDialog) closeLoginDialog();
        });
        listen(document, 'keydown', (event) => {
            if (event.key === 'Escape' && !loginDialog.hidden) closeLoginDialog();
        });
        listen(qualityEl, 'change', () => {
            const quality = QUALITY_OPTIONS.some((option) => option.value === qualityEl.value)
                ? qualityEl.value
                : DEFAULT_QUALITY;
            qualityEl.value = quality;
            syncQualityMenu();
            try {
                localStorage.setItem(QUALITY_STORAGE_KEY, quality);
            } catch {
                // 隐私模式禁用本地存储时，选择仍对当前面板会话有效。
            }
        });

        listen(playToggleButton, 'click', async () => {
            if (!audioEl.src) return;
            hideError();
            if (!audioEl.paused) {
                audioEl.pause();
                return;
            }
            try {
                await audioEl.play();
            } catch (err) {
                if (err?.name !== 'AbortError') showError('播放失败，请重新选择歌曲后重试。');
            }
        });
        listen(downloadCurrentButton, 'click', () => {
            if (selectedSong) void downloadSong(selectedSong, downloadCurrentButton);
        });
        listen(seekEl, 'input', () => {
            const duration = Number.isFinite(audioEl.duration) ? audioEl.duration : 0;
            if (duration > 0) audioEl.currentTime = duration * Number(seekEl.value) / 1000;
        });
        for (const eventName of ['play', 'pause', 'timeupdate', 'loadedmetadata', 'durationchange', 'seeking', 'seeked', 'ended', 'emptied']) {
            listen(audioEl, eventName, updatePlaybackControls);
        }

        /* ---- 封面加载失败时换成占位图,不显示裂图 ---- */
        /* 直接把一小段 SVG 写成 data: URL 塞给 src,不用额外准备图片文件 */
        listen(coverEl, 'error', () => {
            coverEl.src = 'data:image/svg+xml;utf8,' + encodeURIComponent(
                '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">'
                + '<rect width="100%" height="100%" fill="#2a2928"/>'
                + '<text x="50%" y="54%" fill="#6f6b66" font-size="12" '
                + 'text-anchor="middle">♪</text></svg>',
            );
        });

        /* ---- 音频加载失败(直链过期、CDN 拒绝等)给个可操作的提示 ---- */
        listen(audioEl, 'error', () => {
            const playback = activePlayback;
            if (!playback || !playback.url || playback.request !== playRequestSequence) return;
            if (playback.retryInFlight) return;
            if (playback.qualityIndex + 1 < playback.qualities.length) {
                showError('当前音质加载失败，正在尝试兼容音质…');
            }
            void tryPlaybackQuality(playback, playback.qualityIndex + 1);
        });

        /* ---- 按回车搜索 ---- */
        listen(keywordEl, 'keydown', (e) => {
            if (e.key === 'Enter') searchMusic();
        });

        this.panelCleanup = () => {
            if (disposed) return;
            disposed = true;
            qrGeneration += 1;
            accountStatusRequest += 1;
            stopQrPolling();
            if (qrCloseTimer !== null) clearTimeout(qrCloseTimer);
            listeners.abort();
            offServiceChange?.();
            audioEl.pause();
        };
    },

    teardown() {
        this.panelCleanup?.();
        this.panelCleanup = null;
    },
};
