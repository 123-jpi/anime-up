// ==UserScript==
// @name         动漫站点 CDN 识别与多线程缓冲加速助手
// @namespace    https://violentmonkey.github.io/
// @version      1.1.6
// @description  移除危险的自动切线逻辑，修复慢速/高延迟场景下「建议换源」提醒不触发的问题（不再受bufferAhead<1限制），保留手动点播8秒冷却与Alt+P/Alt+Q控制
// @author       You
// @match        *://*/*
// @exclude      *://*.youtube.com/*
// @exclude      *://*.youtu.be/*
// @exclude      *://*.bilibili.com/*
// @exclude      *://*.bilivideo.com/*
// @exclude      *://live.bilibili.com/*
// @exclude      *://*.nicovideo.jp/*
// @exclude      *://*.netflix.com/*
// @exclude      *://*.disneyplus.com/*
// @exclude      *://*.primevideo.com/*
// @exclude      *://*.crunchyroll.com/*
// @exclude      *://*.abema.tv/*
// @exclude      *://*.twitch.tv/*
// @exclude      *://*.kick.com/*
// @exclude      *://*.huya.com/*
// @exclude      *://*.douyu.com/*
// @exclude      *://live.douyin.com/*
// @exclude      *://live.kuaishou.com/*
// @exclude      *://*.sooplive.co.kr/*
// @exclude      *://*.afreecatv.com/*
// @exclude      *://*.twitcasting.tv/*
// @exclude      *://*.showroom-live.com/*
// @exclude      *://*.openrec.tv/*
// @exclude      *://*.iqiyi.com/*
// @exclude      *://*.iq.com/*
// @exclude      *://*.youku.com/*
// @exclude      *://v.qq.com/*
// @exclude      *://*.mgtv.com/*
// @exclude      *://*.acfun.cn/*
// @exclude      *://*.steampowered.com/*
// @exclude      *://steamcommunity.com/*
// @exclude      *://*.x.com/*
// @exclude      *://*.twitter.com/*
// @exclude      *://web.telegram.org/*
// @exclude      *://*.t.me/*
// @exclude      *://*.reddit.com/*
// @exclude      *://tieba.baidu.com/*
// @exclude      *://*.baidu.com/*
// @exclude      *://*.zhihu.com/*
// @exclude      *://*.weibo.com/*
// @exclude      *://*.xiaohongshu.com/*
// @exclude      *://*.douban.com/*
// @exclude      *://*.discord.com/*
// @exclude      *://*.github.com/*
// @exclude      *://*.v2ex.com/*
// @exclude      *://bbs.nga.cn/*
// @exclude      *://nga.178.com/*
// @exclude      *://*.google.com/*
// @exclude      *://*.bing.com/*
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_setClipboard
// @grant        GM_registerMenuCommand
// @connect      *
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    const pageWin = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

    // ---------------- 0. 用户自定义排除域名检查 ----------------

    function getExcludedHosts() {
        try {
            const list = typeof GM_getValue === 'function' ? GM_getValue('anime_cdn_excluded_hosts', []) : [];
            return Array.isArray(list) ? list : [];
        } catch {
            return [];
        }
    }

    function saveExcludedHosts(list) {
        try {
            if (typeof GM_setValue === 'function') {
                GM_setValue('anime_cdn_excluded_hosts', list);
            }
        } catch {}
    }

    const currentHost = pageWin.location.hostname;
    const excludedHosts = getExcludedHosts();

    if (typeof GM_registerMenuCommand === 'function') {
        if (excludedHosts.includes(currentHost)) {
            GM_registerMenuCommand(`恢复此域名运行 (${currentHost})`, () => {
                const updated = getExcludedHosts().filter((h) => h !== currentHost);
                saveExcludedHosts(updated);
                pageWin.location.reload();
            });
            return;
        } else {
            GM_registerMenuCommand(`将此域名加入排除 (${currentHost})`, () => {
                const list = getExcludedHosts();
                if (!list.includes(currentHost)) {
                    list.push(currentHost);
                    saveExcludedHosts(list);
                }
                clearAllEpisodeMemory();
                pageWin.location.reload();
            });
        }
    } else if (excludedHosts.includes(currentHost)) {
        return;
    }

    const DEFAULT_SETTINGS = {
        hotkey: 'Alt+P',
        pillHotkey: 'Alt+Q',
        hideByDefault: true,
        showMiniTrigger: true,
        lowSpeedThresholdKBps: 450,
        hlsSegmentConcurrency: 4,
        hlsSubThreads: 16,
        hlsSubChunkSizeKB: 512,
        hlsPrefetchAhead: 20,
        maxCacheMemoryMB: 512,
        maxMp4PullMB: 2048,
        hlsTargetBufferSec: 240,
        mp4Threads: 20,
        mp4ChunkSizeKB: 1024,
        requestTimeoutMs: 25000,
        maxRetries: 3,
        reservoirMode: 'stream',
        reservoirResumeSec: 12,
        autoPullSlowMp4: true,
    };

    function loadSettings() {
        try {
            const saved = typeof GM_getValue === 'function' ? GM_getValue('anime_cdn_settings_v1', null) : null;
            return saved ? Object.assign({}, DEFAULT_SETTINGS, saved) : Object.assign({}, DEFAULT_SETTINGS);
        } catch {
            return Object.assign({}, DEFAULT_SETTINGS);
        }
    }

    function saveSettings() {
        try {
            if (typeof GM_setValue === 'function') {
                GM_setValue('anime_cdn_settings_v1', settings);
            }
        } catch {}
    }

    const settings = loadSettings();

    const CDN_SIGNATURES = [
        {
            name: 'QQ空间相册 (极速推荐)',
            tag: 'QZONE',
            color: '#10b981',
            urlRegex: /(qpic\.cn|gtimg\.com|qlogo\.cn|photo\.store\.qq\.com|tc\.qq\.com)/i,
            headerRegex: /(x-nws-log-uuid|server:\s*nws|x-daa-tunnel|tencent)/i,
        },
        {
            name: 'Cloudflare CDN',
            tag: 'CF',
            color: '#f59e0b',
            urlRegex: /(cloudflare\.com|workers\.dev|r2\.dev)/i,
            headerRegex: /(cf-ray|server:\s*cloudflare)/i,
        },
        {
            name: 'TikTok / ByteDance CDN',
            tag: 'TIKTOK',
            color: '#ef4444',
            urlRegex: /(tiktokcdn|byteoversea|ibytedtos|byteimg|ttwstatic|pstatp|topbuzzcdn)/i,
            headerRegex: /(x-tt-logid|x-tt-trace|bytedance|x-bdcdn)/i,
        },
        {
            name: 'Akamai CDN',
            tag: 'AKAMAI',
            color: '#ef4444',
            urlRegex: /(akamaized\.net|akamaihd\.net|akamai\.net|edgesuite\.net)/i,
            headerRegex: /(x-akamai|akamai|x-cache.*akamaighost)/i,
        },
        {
            name: '阿里云 / 腾讯云 / 国内云',
            tag: 'CN-CLOUD',
            color: '#3b82f6',
            urlRegex: /(aliyuncs\.com|myqcloud\.com|ksyun\.com|baidubce\.com|cdnhwc)/i,
            headerRegex: /(ali-swift|tcdn|x-oss-|x-cos-|ksyungslb)/i,
        },
    ];

    const state = {
        currentMediaUrl: '',
        currentEpisodeKey: '',
        isLiveStream: false,
        mediaType: 'unknown',
        codecHint: '',
        detectedCdn: { name: '等待识别...', tag: 'INIT', color: '#6b7280' },
        lastSpeedKBps: 0,
        avgSpeedKBps: 0,
        speedSamples: [],
        ttfbMs: 0,
        stallCount: 0,
        bufferAheadSec: 0,
        isProbing: false,
        autoProbedUrls: new Set(),
        rateLimited: false,
        adviceDismissed: false,
        bypassInterception: false,

        videoActivated: false,
        panelOpen: !settings.hideByDefault,
        activeTab: 'monitor',
        recordingTarget: '',
        copiedToast: false,
        probedHosts: new Set(),

        hlsPrefetchEnabled: true,
        hlsRangeSplitSupported: null,
        hlsFullPulling: false,
        playlistSegments: [],
        playlistSet: new Set(),
        lastRequestedSegIdx: 0,
        segmentCache: new Map(),
        cacheBytesUsed: 0,
        segmentInFlight: new Map(),

        mp4Downloading: false,
        mp4Progress: 0,
        mp4CombinedSpeedKBps: 0,
        mp4ActiveThreads: 0,
        mp4DownloadedBytes: 0,
        mp4TotalBytes: 0,
        mp4AutoTriggered: false,
        activeBlobUrl: '',
        isHotSwappingBlob: false,

        isReservoirPaused: false,
        reservoirPausedAt: 0,
        reservoirCooldownUntil: 0,
        lastReservoirCheckAhead: 0,
        lastReservoirProgressTime: 0,
    };

    // ---------------- 1. 动态自适应线程调度 ----------------

    function getAdaptiveHlsPolicy() {
        if (state.rateLimited) {
            return { segConcurrency: 1, subThreads: 2, ahead: settings.hlsPrefetchAhead, modeLabel: '限流退避' };
        }
        if (state.avgSpeedKBps >= 900 && !state.hlsFullPulling) {
            return { segConcurrency: 2, subThreads: 2, ahead: 10, modeLabel: '高速省流(2x)' };
        }
        if (state.avgSpeedKBps >= settings.lowSpeedThresholdKBps && !state.hlsFullPulling) {
            return { segConcurrency: 3, subThreads: 6, ahead: settings.hlsPrefetchAhead, modeLabel: '均衡(6x)' };
        }
        const segConc = state.hlsFullPulling ? 6 : Math.max(4, settings.hlsSegmentConcurrency);
        return {
            segConcurrency: segConc,
            subThreads: settings.hlsSubThreads,
            ahead: state.hlsFullPulling ? state.playlistSegments.length : Math.max(24, settings.hlsPrefetchAhead),
            modeLabel: `全力(${settings.hlsSubThreads}x)`
        };
    }

    // ---------------- 2. 生命周期内存清理 ----------------

    function clearAllEpisodeMemory() {
        state.segmentCache.clear();
        state.cacheBytesUsed = 0;
        state.segmentInFlight.clear();
        state.playlistSegments = [];
        state.playlistSet.clear();
        state.lastRequestedSegIdx = 0;
        state.hlsFullPulling = false;
        state.mp4AutoTriggered = false;
        state.mp4DownloadedBytes = 0;
        state.mp4TotalBytes = 0;
        state.stallCount = 0;
        state.isReservoirPaused = false;
        state.rateLimited = false;
        state.adviceDismissed = false;
        state.bypassInterception = false;
        if (state.activeBlobUrl) {
            try { URL.revokeObjectURL(state.activeBlobUrl); } catch {}
            state.activeBlobUrl = '';
        }
        scheduleUIUpdate();
    }

    function getEpisodeKey(url) {
        try {
            const u = new URL(url);
            return `${u.origin}${u.pathname}`;
        } catch {
            return url;
        }
    }

    // ---------------- 3. 媒体识别与自动测速 ----------------

    const MEDIA_EXT_REGEX = /\.(m3u8|mp4|m4s|ts|flv|webm|hevc|h265)(\?|$)/i;
    const MEDIA_CT_REGEX = /(video\/|mpegurl|mp2t|iso\.segment|octet-stream)/i;

    function resolveUrl(url, base = pageWin.location.href) {
        try {
            return new URL(url, base).href;
        } catch {
            return url;
        }
    }

    function detectCodecFromText(txt) {
        if (!txt) return;
        if (/(hvc1|hev1|hevc|h\.?265)/i.test(txt)) {
            state.codecHint = 'HEVC/H.265';
        } else if (/(avc1|h\.?264)/i.test(txt) && !state.codecHint) {
            state.codecHint = 'H.264';
        }
    }

    function checkAutoPullMp4() {
        if (
            settings.autoPullSlowMp4 &&
            settings.reservoirMode !== 'off' &&
            !state.mp4AutoTriggered &&
            !state.mp4Downloading &&
            !state.activeBlobUrl &&
            state.mediaType === 'mp4' &&
            state.avgSpeedKBps > 0 &&
            state.avgSpeedKBps < settings.lowSpeedThresholdKBps
        ) {
            state.mp4AutoTriggered = true;
            startIdmMp4Download(true);
        }
    }

    function recordMediaUrl(url, typeHint = 'unknown') {
        if (!url || typeof url !== 'string' || !url.startsWith('http')) return;
        detectCodecFromText(url);

        const isMasterOrMain = typeHint === 'hls' || typeHint === 'mp4' || /\.(m3u8|mp4|flv|webm)(\?|$)/i.test(url);
        if (isMasterOrMain) {
            const epKey = getEpisodeKey(url);
            if (state.currentEpisodeKey && state.currentEpisodeKey !== epKey && !url.endsWith('.ts') && !url.endsWith('.m4s')) {
                clearAllEpisodeMemory();
            }
            state.currentEpisodeKey = epKey;
        }

        if (typeHint === 'hls' || /\.m3u8(\?|$)/i.test(url)) {
            state.mediaType = 'hls';
            state.currentMediaUrl = url;
        } else if (typeHint === 'mp4' || /\.(mp4|flv|webm)(\?|$)/i.test(url)) {
            if (state.mediaType !== 'hls') state.mediaType = 'mp4';
            state.currentMediaUrl = url;
        } else if (!state.currentMediaUrl) {
            state.currentMediaUrl = url;
        }

        try {
            const host = new URL(url).hostname;
            if (!state.probedHosts.has(host)) {
                state.probedHosts.add(host);
                identifyCdn(url);
            }
        } catch {}

        if (state.currentMediaUrl && state.lastSpeedKBps === 0 && !state.autoProbedUrls.has(state.currentMediaUrl)) {
            state.autoProbedUrls.add(state.currentMediaUrl);
            setTimeout(() => {
                if (state.lastSpeedKBps === 0 && !state.isProbing) {
                    probeActiveSpeed();
                }
            }, 350);
        }

        checkAutoPullMp4();
        scheduleUIUpdate();
    }

    // ---------------- 4. M3U8 解析、直接接管与 HLS 整集拉取 ----------------

    function parseM3U8(text, baseUrl) {
        if (!text || !text.includes('#EXTM3U')) return;
        detectCodecFromText(text);

        const isVod = text.includes('#EXT-X-ENDLIST');
        state.isLiveStream = !isVod;
        if (state.isLiveStream) return;

        const lines = text.split(/\r?\n/);
        const segments = [];
        for (const raw of lines) {
            const line = raw.trim();
            if (!line) continue;

            if (line.startsWith('#EXT-X-MAP:')) {
                const m = line.match(/URI="([^"]+)"/i);
                if (m && m[1]) {
                    const initUrl = resolveUrl(m[1], baseUrl);
                    getOrFetchSegmentMultiThread(initUrl);
                }
                continue;
            }

            if (line.startsWith('#')) continue;
            if (/\.m3u8(\?|$)/i.test(line)) continue;
            segments.push(resolveUrl(line, baseUrl));
        }

        if (segments.length > 0) {
            if (state.playlistSegments.length > 0 && state.playlistSegments[0] !== segments[0]) {
                clearAllEpisodeMemory();
            }
            state.playlistSegments = segments;
            state.playlistSet = new Set(segments);
            state.mediaType = 'hls';
            recordMediaUrl(baseUrl, 'hls');
            pumpHlsPrefetch();
        }
    }

    function readFromCacheKeepLRU(url) {
        const entry = state.segmentCache.get(url);
        if (!entry) return null;
        state.segmentCache.delete(url);
        entry.lastAccess = Date.now();
        state.segmentCache.set(url, entry);
        return entry;
    }

    function saveSegmentToCache(segUrl, arrayBuffer, contentType, startTimeMs) {
        const sec = (performance.now() - startTimeMs) / 1000;
        if (arrayBuffer.byteLength > 10240 && sec > 0.01) {
            recordSpeed(Math.round((arrayBuffer.byteLength / 1024) / sec));
        }

        const maxBytes = Math.max(128, settings.maxCacheMemoryMB) * 1024 * 1024;
        if (arrayBuffer.byteLength > maxBytes) return { buffer: arrayBuffer, contentType };

        while (state.cacheBytesUsed + arrayBuffer.byteLength > maxBytes && state.segmentCache.size > 0) {
            const oldestKey = state.segmentCache.keys().next().value;
            const removed = state.segmentCache.get(oldestKey);
            state.segmentCache.delete(oldestKey);
            if (removed) state.cacheBytesUsed = Math.max(0, state.cacheBytesUsed - removed.buffer.byteLength);
        }

        const entry = { buffer: arrayBuffer, contentType, lastAccess: Date.now() };
        state.segmentCache.set(segUrl, entry);
        state.cacheBytesUsed += arrayBuffer.byteLength;
        scheduleUIUpdate();
        return entry;
    }

    function pumpHlsPrefetch() {
        if (state.bypassInterception || (!state.hlsPrefetchEnabled && !state.hlsFullPulling) || state.isLiveStream || state.playlistSegments.length === 0) return;
        const maxBytes = Math.max(128, settings.maxCacheMemoryMB) * 1024 * 1024;
        if (state.cacheBytesUsed >= maxBytes * 0.96) {
            state.hlsFullPulling = false;
            return;
        }

        const policy = getAdaptiveHlsPolicy();
        const startIdx = Math.max(0, state.lastRequestedSegIdx);
        const endIdx = Math.min(state.playlistSegments.length, startIdx + policy.ahead);

        let allDone = true;
        for (let i = startIdx; i < endIdx; i++) {
            const segUrl = state.playlistSegments[i];
            if (!state.segmentCache.has(segUrl)) {
                allDone = false;
                if (state.segmentInFlight.size < policy.segConcurrency && !state.segmentInFlight.has(segUrl)) {
                    getOrFetchSegmentMultiThread(segUrl).then(() => pumpHlsPrefetch());
                }
            }
        }
        if (state.hlsFullPulling && allDone) {
            state.hlsFullPulling = false;
            scheduleUIUpdate();
        }
    }

    function toggleHlsFullPull() {
        if (state.playlistSegments.length === 0) return;
        state.bypassInterception = false;
        state.hlsFullPulling = !state.hlsFullPulling;
        if (state.hlsFullPulling) {
            state.hlsPrefetchEnabled = true;
            pumpHlsPrefetch();
        }
        scheduleUIUpdate();
    }

    function gmRangeGet(url, start, end, timeoutMs = settings.requestTimeoutMs) {
        return new Promise((resolve, reject) => {
            const headers = { Referer: pageWin.location.href };
            if (start !== null && end !== null) {
                headers.Range = `bytes=${start}-${end}`;
            }
            GM_xmlhttpRequest({
                method: 'GET',
                url,
                headers,
                responseType: 'arraybuffer',
                timeout: timeoutMs,
                onload: (res) => resolve(res),
                onerror: () => reject(new Error('network error')),
                ontimeout: () => reject(new Error('timeout')),
            });
        });
    }

    function extractContentType(rawHeaders = '', fallback = 'application/octet-stream') {
        const m = rawHeaders.match(/content-type:\s*([^\r\n;]+)/i);
        return m ? m[1].trim() : fallback;
    }

    function getOrFetchSegmentMultiThread(segUrl) {
        if (state.segmentCache.has(segUrl)) {
            return Promise.resolve(readFromCacheKeepLRU(segUrl));
        }
        if (state.segmentInFlight.has(segUrl)) {
            return state.segmentInFlight.get(segUrl);
        }
        if (typeof GM_xmlhttpRequest !== 'function') {
            return Promise.resolve(null);
        }

        const promise = (async () => {
            const totalStart = performance.now();
            const policy = getAdaptiveHlsPolicy();
            const chunkBytes = Math.max(128, settings.hlsSubChunkSizeKB) * 1024;

            try {
                if (state.hlsRangeSplitSupported === false) {
                    for (let attempt = 0; attempt <= settings.maxRetries; attempt++) {
                        try {
                            const res = await gmRangeGet(segUrl, null, null, settings.requestTimeoutMs);
                            if (res.status === 429 || res.status === 503) {
                                state.rateLimited = true;
                                break;
                            }
                            if (res.status >= 200 && res.status < 300 && res.response) {
                                const ct = extractContentType(res.responseHeaders, 'video/mp2t');
                                return saveSegmentToCache(segUrl, res.response, ct, totalStart);
                            }
                        } catch {}
                    }
                    return null;
                }

                let firstRes = null;
                for (let attempt = 0; attempt <= settings.maxRetries; attempt++) {
                    try {
                        firstRes = await gmRangeGet(segUrl, 0, chunkBytes - 1, settings.requestTimeoutMs);
                        if (firstRes && (firstRes.status === 429 || firstRes.status === 503)) {
                            state.rateLimited = true;
                            return null;
                        }
                        if (firstRes && firstRes.response) break;
                    } catch {}
                }
                if (!firstRes || !firstRes.response) return null;

                const ct = extractContentType(firstRes.responseHeaders, /\.m4s|\.mp4/i.test(segUrl) ? 'video/mp4' : 'video/mp2t');

                if (firstRes.status === 200) {
                    state.hlsRangeSplitSupported = false;
                    return saveSegmentToCache(segUrl, firstRes.response, ct, totalStart);
                }

                if (firstRes.status === 206) {
                    state.hlsRangeSplitSupported = true;
                    const crMatch = (firstRes.responseHeaders || '').match(/content-range:\s*bytes\s+\d+-\d+\/(\d+)/i);
                    const totalBytes = crMatch ? Number(crMatch[1]) : 0;

                    if (!totalBytes || firstRes.response.byteLength >= totalBytes) {
                        return saveSegmentToCache(segUrl, firstRes.response, ct, totalStart);
                    }

                    const tasks = [];
                    for (let offset = firstRes.response.byteLength; offset < totalBytes; offset += chunkBytes) {
                        tasks.push({
                            start: offset,
                            end: Math.min(offset + chunkBytes - 1, totalBytes - 1),
                        });
                    }

                    const parts = new Array(tasks.length + 1);
                    parts[0] = firstRes.response;
                    let nextTaskIdx = 0;

                    async function worker() {
                        while (nextTaskIdx < tasks.length) {
                            const myIdx = nextTaskIdx++;
                            const t = tasks[myIdx];
                            for (let attempt = 0; attempt <= settings.maxRetries; attempt++) {
                                try {
                                    const r = await gmRangeGet(segUrl, t.start, t.end, settings.requestTimeoutMs);
                                    if (r.status === 429 || r.status === 503) {
                                        state.rateLimited = true;
                                        return;
                                    }
                                    if (r.response && r.response.byteLength > 0) {
                                        parts[myIdx + 1] = r.response;
                                        break;
                                    }
                                } catch {}
                            }
                        }
                    }

                    const workers = [];
                    const threadCount = Math.min(policy.subThreads, tasks.length);
                    for (let i = 0; i < threadCount; i++) workers.push(worker());
                    await Promise.all(workers);

                    if (parts.every(Boolean)) {
                        const merged = new Uint8Array(totalBytes);
                        let pos = 0;
                        for (const buf of parts) {
                            merged.set(new Uint8Array(buf), pos);
                            pos += buf.byteLength;
                        }
                        return saveSegmentToCache(segUrl, merged.buffer, ct, totalStart);
                    }
                }
                return null;
            } catch {
                return null;
            } finally {
                state.segmentInFlight.delete(segUrl);
                scheduleUIUpdate();
            }
        })();

        state.segmentInFlight.set(segUrl, promise);
        return promise;
    }

    // ---------------- 5. 劫持页面网络请求 ----------------

    function hookPageNetwork() {
        if (pageWin.MediaSource && pageWin.MediaSource.prototype.addSourceBuffer) {
            const origAddSB = pageWin.MediaSource.prototype.addSourceBuffer;
            pageWin.MediaSource.prototype.addSourceBuffer = function (mimeType) {
                detectCodecFromText(mimeType);
                scheduleUIUpdate();
                return origAddSB.apply(this, arguments);
            };
        }

        const origFetch = pageWin.fetch;
        if (typeof origFetch === 'function') {
            pageWin.fetch = async function (input, init) {
                const rawUrl = typeof input === 'string' ? input : (input && input.url);
                const fullUrl = rawUrl ? resolveUrl(rawUrl) : '';

                if (
                    fullUrl &&
                    !state.bypassInterception &&
                    state.hlsPrefetchEnabled &&
                    !state.isLiveStream &&
                    (state.segmentCache.has(fullUrl) || state.playlistSet.has(fullUrl))
                ) {
                    const segIdx = state.playlistSegments.indexOf(fullUrl);
                    if (segIdx !== -1) state.lastRequestedSegIdx = segIdx;
                    const entry = await getOrFetchSegmentMultiThread(fullUrl);
                    pumpHlsPrefetch();
                    if (entry && entry.buffer) {
                        return new pageWin.Response(entry.buffer.slice(0), {
                            status: 200,
                            statusText: 'OK',
                            headers: { 'Content-Type': entry.contentType || 'application/octet-stream' },
                        });
                    }
                }

                if (fullUrl && MEDIA_EXT_REGEX.test(fullUrl)) {
                    recordMediaUrl(fullUrl);
                }

                const res = await origFetch.apply(this, arguments);
                try {
                    const ct = res.headers.get('content-type') || '';
                    const cl = Number(res.headers.get('content-length') || 0);
                    if (MEDIA_CT_REGEX.test(ct) && (cl === 0 || cl > 100 * 1024 || /mpegurl/i.test(ct))) {
                        const hint = /mpegurl/i.test(ct) ? 'hls' : (/video\/(mp4|webm|x-flv)/i.test(ct) ? 'mp4' : 'unknown');
                        recordMediaUrl(fullUrl, hint);
                    }
                    if (/mpegurl|text\/plain|application\/octet-stream/i.test(ct) || /\.m3u8/i.test(fullUrl)) {
                        const clone = res.clone();
                        clone.text().then((txt) => {
                            if (txt && txt.trimStart().includes('#EXTM3U')) parseM3U8(txt, fullUrl);
                        }).catch(() => {});
                    }
                } catch {}
                return res;
            };
        }

        const OrigXHR = pageWin.XMLHttpRequest;
        if (OrigXHR) {
            const origOpen = OrigXHR.prototype.open;
            const origSend = OrigXHR.prototype.send;
            const origAbort = OrigXHR.prototype.abort;

            OrigXHR.prototype.open = function (method, url) {
                this._cdnUrl = url ? resolveUrl(url) : '';
                this._cdnAborted = false;
                if (this._cdnUrl && MEDIA_EXT_REGEX.test(this._cdnUrl)) {
                    recordMediaUrl(this._cdnUrl);
                }
                return origOpen.apply(this, arguments);
            };

            OrigXHR.prototype.abort = function () {
                this._cdnAborted = true;
                return origAbort.apply(this, arguments);
            };

            OrigXHR.prototype.send = function () {
                const url = this._cdnUrl;
                const sendArgs = arguments;

                const isHlsSeg = url &&
                    !state.bypassInterception &&
                    state.hlsPrefetchEnabled &&
                    !state.isLiveStream &&
                    (this.responseType === 'arraybuffer' || this.responseType === 'blob') &&
                    (state.segmentCache.has(url) || state.playlistSet.has(url));

                if (isHlsSeg) {
                    const segIdx = state.playlistSegments.indexOf(url);
                    if (segIdx !== -1) state.lastRequestedSegIdx = segIdx;

                    getOrFetchSegmentMultiThread(url).then((entry) => {
                        if (this._cdnAborted) return;
                        pumpHlsPrefetch();
                        if (entry && entry.buffer) {
                            const ct = entry.contentType || 'video/mp2t';
                            const respObj = this.responseType === 'blob'
                                ? new Blob([entry.buffer], { type: ct })
                                : entry.buffer.slice(0);
                            const len = entry.buffer.byteLength;

                            try {
                                const headerMap = {
                                    'content-type': ct,
                                    'content-length': String(len),
                                };
                                this.getResponseHeader = (name) => headerMap[String(name).toLowerCase()] || null;
                                this.getAllResponseHeaders = () => `content-type: ${ct}\r\ncontent-length: ${len}\r\n`;

                                Object.defineProperty(this, 'status', { value: 200, configurable: true });
                                Object.defineProperty(this, 'statusText', { value: 'OK', configurable: true });
                                Object.defineProperty(this, 'responseURL', { value: url, configurable: true });

                                Object.defineProperty(this, 'readyState', { value: 2, configurable: true });
                                this.dispatchEvent(new pageWin.Event('readystatechange'));

                                Object.defineProperty(this, 'response', { value: respObj, configurable: true });
                                Object.defineProperty(this, 'readyState', { value: 4, configurable: true });
                                this.dispatchEvent(new pageWin.Event('readystatechange'));

                                this.dispatchEvent(new ProgressEvent('progress', { loaded: len, total: len, lengthComputable: true }));
                                this.dispatchEvent(new ProgressEvent('load', { loaded: len, total: len, lengthComputable: true }));
                                this.dispatchEvent(new ProgressEvent('loadend', { loaded: len, total: len, lengthComputable: true }));
                                return;
                            } catch {}
                        }
                        origSend.apply(this, sendArgs);
                    });
                    return;
                }

                this.addEventListener('load', function () {
                    try {
                        const ct = this.getResponseHeader('content-type') || '';
                        if (MEDIA_CT_REGEX.test(ct)) {
                            const hint = /mpegurl/i.test(ct) ? 'hls' : (/video\/(mp4|webm|x-flv)/i.test(ct) ? 'mp4' : 'unknown');
                            recordMediaUrl(url, hint);
                        }
                        if ((this.responseType === '' || this.responseType === 'text') && typeof this.responseText === 'string') {
                            if (this.responseText.trimStart().includes('#EXTM3U')) {
                                parseM3U8(this.responseText, url);
                            }
                        }
                    } catch {}
                });

                return origSend.apply(this, arguments);
            };
        }

        let _Hls = pageWin.Hls;
        function wrapHls(HlsClass) {
            if (!HlsClass || HlsClass._cdnWrapped) return HlsClass;
            const WrappedHls = function (userConfig = {}) {
                const patchedConfig = Object.assign({}, userConfig, {
                    maxBufferLength: Math.max(userConfig.maxBufferLength || 0, settings.hlsTargetBufferSec),
                    maxMaxBufferLength: Math.max(userConfig.maxMaxBufferLength || 0, 600),
                    maxBufferSize: Math.max(userConfig.maxBufferSize || 0, settings.maxCacheMemoryMB * 1000 * 1000),
                    fragLoadingTimeOut: Math.max(userConfig.fragLoadingTimeOut || 0, settings.requestTimeoutMs),
                    fragLoadingMaxRetry: Math.max(userConfig.fragLoadingMaxRetry || 0, 8),
                    fragLoadingRetryDelay: 500,
                });
                return new HlsClass(patchedConfig);
            };
            Object.setPrototypeOf(WrappedHls, HlsClass);
            WrappedHls.prototype = HlsClass.prototype;
            WrappedHls._cdnWrapped = true;
            return WrappedHls;
        }

        if (_Hls) {
            try { pageWin.Hls = wrapHls(_Hls); } catch {}
        } else {
            try {
                Object.defineProperty(pageWin, 'Hls', {
                    configurable: true,
                    enumerable: true,
                    get: () => _Hls,
                    set: (val) => { _Hls = wrapHls(val); },
                });
            } catch {}
        }
    }

    // ---------------- 6. CDN 响应头穿透识别 ----------------

    function matchCdnSignature(url, rawHeaders = '') {
        for (const sig of CDN_SIGNATURES) {
            if (sig.urlRegex.test(url) || (rawHeaders && sig.headerRegex.test(rawHeaders))) {
                return sig;
            }
        }
        try {
            const host = new URL(url).hostname;
            return { name: `未知/自建 (${host})`, tag: 'CUSTOM', color: '#8b5cf6' };
        } catch {
            return { name: '未知 CDN', tag: 'UNKNOWN', color: '#6b7280' };
        }
    }

    function identifyCdn(url) {
        state.detectedCdn = matchCdnSignature(url, '');
        scheduleUIUpdate();

        if (typeof GM_xmlhttpRequest === 'function') {
            GM_xmlhttpRequest({
                method: 'HEAD',
                url: url,
                headers: { Referer: pageWin.location.href },
                timeout: 6000,
                onload: function (res) {
                    state.detectedCdn = matchCdnSignature(url, res.responseHeaders || '');
                    const ct = extractContentType(res.responseHeaders || '', '');
                    if (/video\/(mp4|webm|x-flv)/i.test(ct) && state.mediaType !== 'hls') {
                        state.mediaType = 'mp4';
                        checkAutoPullMp4();
                    }
                    scheduleUIUpdate();
                },
                onerror: function () {
                    GM_xmlhttpRequest({
                        method: 'GET',
                        url: url,
                        headers: { Referer: pageWin.location.href, Range: 'bytes=0-1' },
                        timeout: 6000,
                        onload: function (res) {
                            state.detectedCdn = matchCdnSignature(url, res.responseHeaders || '');
                            const ct = extractContentType(res.responseHeaders || '', '');
                            if (/video\/(mp4|webm|x-flv)/i.test(ct) && state.mediaType !== 'hls') {
                                state.mediaType = 'mp4';
                                checkAutoPullMp4();
                            }
                            scheduleUIUpdate();
                        },
                    });
                },
            });
        }
    }

    // ---------------- 7. PerformanceObserver 兜底监控 ----------------

    function startPerformanceMonitor() {
        if (!pageWin.PerformanceObserver) return;
        try {
            const observer = new pageWin.PerformanceObserver((list) => {
                for (const entry of list.getEntries()) {
                    if (entry.name.startsWith('blob:')) continue;
                    const bytes = entry.transferSize || entry.encodedBodySize || 0;
                    const isMediaExt = MEDIA_EXT_REGEX.test(entry.name);
                    const isLargeChunk = bytes > 150 * 1024 && (entry.initiatorType === 'xmlhttprequest' || entry.initiatorType === 'fetch' || entry.initiatorType === 'video');

                    if (!isMediaExt && !isLargeChunk) continue;

                    const durationSec = (entry.responseEnd - entry.responseStart) / 1000;
                    const ttfb = Math.round(entry.responseStart - entry.requestStart);
                    if (ttfb > 0) state.ttfbMs = ttfb;

                    if (bytes > 10240 && durationSec > 0.01) {
                        recordSpeed(Math.round((bytes / 1024) / durationSec));
                    }
                    recordMediaUrl(entry.name, entry.initiatorType === 'video' ? 'mp4' : 'unknown');
                }
            });
            observer.observe({ entryTypes: ['resource'] });
        } catch {}
    }

    function recordSpeed(speedKBps) {
        state.lastSpeedKBps = speedKBps;
        state.speedSamples.push(speedKBps);
        if (state.speedSamples.length > 8) state.speedSamples.shift();
        state.avgSpeedKBps = Math.round(state.speedSamples.reduce((a, b) => a + b, 0) / state.speedSamples.length);

        checkAutoPullMp4();
        scheduleUIUpdate();
    }

    // ---------------- 8. 自动测速 & MP4 整集多线程拉取 ----------------

    function probeActiveSpeed() {
        if (!state.currentMediaUrl || state.isProbing || typeof GM_xmlhttpRequest !== 'function') return;
        state.isProbing = true;
        scheduleUIUpdate();

        const start = performance.now();
        let ttfb = 0;

        GM_xmlhttpRequest({
            method: 'GET',
            url: state.currentMediaUrl,
            headers: {
                Referer: pageWin.location.href,
                Range: `bytes=0-${512 * 1024 - 1}`,
            },
            responseType: 'arraybuffer',
            timeout: settings.requestTimeoutMs,
            onreadystatechange: (res) => {
                if (res.readyState === 2 && !ttfb) ttfb = Math.round(performance.now() - start);
            },
            onload: (res) => {
                const sec = (performance.now() - start) / 1000;
                const bytes = res.response ? res.response.byteLength : 0;
                if (ttfb) state.ttfbMs = ttfb;
                if (bytes > 0 && sec > 0) recordSpeed(Math.round((bytes / 1024) / sec));
                state.detectedCdn = matchCdnSignature(state.currentMediaUrl, res.responseHeaders || '');
                const ct = extractContentType(res.responseHeaders || '', '');
                if (/video\/(mp4|webm|x-flv)/i.test(ct) && state.mediaType !== 'hls') {
                    state.mediaType = 'mp4';
                    checkAutoPullMp4();
                }
                state.isProbing = false;
                scheduleUIUpdate();
            },
            onerror: () => { state.isProbing = false; scheduleUIUpdate(); },
            ontimeout: () => { state.isProbing = false; scheduleUIUpdate(); },
        });
    }

    async function startIdmMp4Download(silent = false) {
        if (!state.currentMediaUrl || state.mp4Downloading || typeof GM_xmlhttpRequest !== 'function') return;
        state.mp4Downloading = true;
        state.mp4Progress = 0;
        state.mp4DownloadedBytes = 0;
        state.mp4TotalBytes = 0;
        scheduleUIUpdate();

        try {
            const headRes = await new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method: 'HEAD',
                    url: state.currentMediaUrl,
                    headers: { Referer: pageWin.location.href },
                    timeout: settings.requestTimeoutMs,
                    onload: resolve,
                    onerror: reject,
                    ontimeout: reject,
                });
            });

            const m = (headRes.responseHeaders || '').match(/content-length:\s*(\d+)/i);
            const totalSize = m ? Number(m[1]) : 0;
            const maxMp4Bytes = Math.max(512, settings.maxMp4PullMB) * 1024 * 1024;
            if (!totalSize || totalSize > maxMp4Bytes) {
                if (!silent) {
                    alert(`该源未返回文件大小或超出上限 (${settings.maxMp4PullMB} MB)，可在设置中调高「剧场版/整集上限」`);
                }
                state.mp4Downloading = false;
                scheduleUIUpdate();
                return;
            }

            const adaptiveChunkKB = totalSize > 400 * 1024 * 1024
                ? Math.max(2048, settings.mp4ChunkSizeKB)
                : Math.max(512, settings.mp4ChunkSizeKB);
            const chunkBytes = adaptiveChunkKB * 1024;

            state.mp4TotalBytes = totalSize;
            const chunks = [];
            for (let offset = 0; offset < totalSize; offset += chunkBytes) {
                chunks.push({
                    index: chunks.length,
                    start: offset,
                    end: Math.min(offset + chunkBytes - 1, totalSize - 1),
                });
            }

            const video = document.querySelector('video');
            let startChunkIdx = 0;
            if (video && video.duration > 0 && video.currentTime > 0) {
                startChunkIdx = Math.min(chunks.length - 1, Math.floor((video.currentTime / video.duration) * chunks.length));
            }
            const orderedQueue = [
                ...chunks.slice(startChunkIdx),
                ...chunks.slice(0, startChunkIdx),
            ];

            const results = new Array(chunks.length);
            let nextQueuePos = 0;
            let completedBytes = 0;
            const startTime = performance.now();

            let targetConcurrency = Math.min(settings.mp4Threads, chunks.length);
            let activeWorkers = 0;
            let consecutiveErrors = 0;

            async function worker(workerId) {
                activeWorkers++;
                try {
                    while (nextQueuePos < orderedQueue.length) {
                        if (workerId >= targetConcurrency) break;
                        const task = orderedQueue[nextQueuePos++];

                        for (let attempt = 0; attempt <= settings.maxRetries; attempt++) {
                            try {
                                const res = await gmRangeGet(state.currentMediaUrl, task.start, task.end, settings.requestTimeoutMs);
                                if (res.status === 429 || res.status === 503) {
                                    state.rateLimited = true;
                                    targetConcurrency = Math.max(2, Math.floor(targetConcurrency / 2));
                                    await new Promise((r) => setTimeout(r, 800));
                                    continue;
                                }
                                if (res.response && res.response.byteLength > 0) {
                                    results[task.index] = res.response;
                                    completedBytes += res.response.byteLength;
                                    consecutiveErrors = 0;
                                    const elapsedSec = (performance.now() - startTime) / 1000;
                                    state.mp4DownloadedBytes = completedBytes;
                                    state.mp4Progress = Math.round((completedBytes / totalSize) * 100);
                                    state.mp4CombinedSpeedKBps = Math.round((completedBytes / 1024) / Math.max(elapsedSec, 0.1));
                                    state.mp4ActiveThreads = activeWorkers;
                                    scheduleUIUpdate();
                                    break;
                                }
                            } catch {
                                consecutiveErrors++;
                                if (consecutiveErrors >= 4 && targetConcurrency > 3) {
                                    targetConcurrency = Math.max(3, Math.floor(targetConcurrency / 2));
                                }
                            }
                        }
                    }
                } finally {
                    activeWorkers--;
                    state.mp4ActiveThreads = activeWorkers;
                }
            }

            const workers = [];
            for (let i = 0; i < targetConcurrency; i++) {
                workers.push(worker(i));
            }
            await Promise.all(workers);

            if (results.every(Boolean)) {
                if (state.activeBlobUrl) {
                    try { URL.revokeObjectURL(state.activeBlobUrl); } catch {}
                }
                const blob = new Blob(results, { type: 'video/mp4' });
                const blobUrl = URL.createObjectURL(blob);
                state.activeBlobUrl = blobUrl;

                const v = document.querySelector('video');
                if (v) {
                    const savedTime = v.currentTime;
                    const savedPaused = v.paused;
                    const savedRate = v.playbackRate;

                    state.isHotSwappingBlob = true;
                    v.addEventListener('loadedmetadata', function onMeta() {
                        v.removeEventListener('loadedmetadata', onMeta);
                        state.isHotSwappingBlob = false;
                        v.currentTime = savedTime;
                        v.playbackRate = savedRate;
                        if (!savedPaused) v.play().catch(() => {});
                        scheduleUIUpdate();
                    }, { once: true });

                    v.src = blobUrl;
                    v.load();
                }
            }
        } catch {
        } finally {
            state.mp4Downloading = false;
            state.mp4ActiveThreads = 0;
            scheduleUIUpdate();
        }
    }

    // ---------------- 9. 边蓄边播 + 手动点播尊重 + 防死循环 ----------------

    function shouldPauseReservoir() {
        if (state.isLiveStream) return false;
        return settings.reservoirMode === 'pause';
    }

    function activateVideoMode() {
        if (!state.videoActivated) {
            state.videoActivated = true;
            ensureOverlayElements();
            scheduleUIUpdate();
        }
    }

    function tryAutoResumeVideo(video, ahead) {
        if (!state.isReservoirPaused) return;
        const now = Date.now();
        if (now - state.reservoirPausedAt < 2500) return;

        const readyToPlay = video.readyState >= 3 && ahead >= settings.reservoirResumeSec;
        const stalledLongEnough = now - state.lastReservoirProgressTime > 10000;

        if (readyToPlay || stalledLongEnough) {
            state.isReservoirPaused = false;
            state.reservoirCooldownUntil = now + 4500;
            video.play().catch(() => {});
            scheduleUIUpdate();
        }
    }

    let seekDebounceTimer = null;

    function bindVideoEvents(video) {
        if (video.dataset.cdnBound) return;
        video.dataset.cdnBound = '1';

        const checkActive = () => {
            const src = video.currentSrc || video.src;
            if (src || video.readyState > 0 || !video.paused) {
                activateVideoMode();
                if (src && !src.startsWith('blob:')) {
                    const hint = /\.m3u8/i.test(src) ? 'hls' : 'mp4';
                    recordMediaUrl(src, hint);
                }
            }
        };

        checkActive();
        video.addEventListener('loadedmetadata', checkActive);

        video.addEventListener('emptied', () => {
            if (state.isHotSwappingBlob) return;
            const src = video.currentSrc || video.src;
            if (!state.activeBlobUrl || (src && src !== state.activeBlobUrl && !src.startsWith('blob:'))) {
                clearAllEpisodeMemory();
            }
        });

        video.addEventListener('play', () => {
            checkActive();
            if (state.isReservoirPaused) {
                state.isReservoirPaused = false;
                state.reservoirCooldownUntil = Date.now() + 8000;
                scheduleUIUpdate();
            }
        });

        video.addEventListener('playing', () => {
            checkActive();
            state.stallCount = 0;
            state.isReservoirPaused = false;
            scheduleUIUpdate();
        });

        video.addEventListener('seeked', () => {
            if (seekDebounceTimer) clearTimeout(seekDebounceTimer);
            seekDebounceTimer = setTimeout(() => {
                if (state.playlistSegments.length > 0 && video.duration > 0) {
                    const ratio = Math.min(0.99, Math.max(0, video.currentTime / video.duration));
                    state.lastRequestedSegIdx = Math.floor(ratio * state.playlistSegments.length);
                    pumpHlsPrefetch();
                }
            }, 250);
        });

        video.addEventListener('waiting', () => {
            state.stallCount += 1;
            const now = Date.now();

            if (!state.bypassInterception && state.stallCount >= 3 && state.bufferAheadSec < 0.5 && state.avgSpeedKBps >= 500 && state.segmentCache.size > 0) {
                state.bypassInterception = true;
            }

            if (
                shouldPauseReservoir() &&
                !video.paused &&
                !state.isReservoirPaused &&
                now > state.reservoirCooldownUntil &&
                state.bufferAheadSec < settings.reservoirResumeSec
            ) {
                state.isReservoirPaused = true;
                state.reservoirPausedAt = now;
                state.lastReservoirProgressTime = now;
                state.lastReservoirCheckAhead = state.bufferAheadSec;
                video.pause();
            }
            scheduleUIUpdate();
        });

        video.addEventListener('timeupdate', () => {
            try {
                const ct = video.currentTime;
                let ahead = 0;
                for (let i = 0; i < video.buffered.length; i++) {
                    if (video.buffered.start(i) <= ct && ct <= video.buffered.end(i)) {
                        ahead = Number((video.buffered.end(i) - ct).toFixed(1));
                        break;
                    }
                }
                state.bufferAheadSec = ahead;
                tryAutoResumeVideo(video, ahead);
                scheduleUIUpdate();
            } catch {}
        });

        setInterval(() => {
            if (!state.isReservoirPaused) return;
            try {
                const ct = video.currentTime;
                let ahead = 0;
                for (let i = 0; i < video.buffered.length; i++) {
                    if (video.buffered.start(i) <= ct && ct <= video.buffered.end(i)) {
                        ahead = Number((video.buffered.end(i) - ct).toFixed(1));
                        break;
                    }
                }
                if (ahead > state.lastReservoirCheckAhead + 0.1) {
                    state.lastReservoirCheckAhead = ahead;
                    state.lastReservoirProgressTime = Date.now();
                }
                state.bufferAheadSec = ahead;
                tryAutoResumeVideo(video, ahead);
                scheduleUIUpdate();
            } catch {}
        }, 500);
    }

    // ---------------- 10. Alt+P(面板) & Alt+Q(小胶囊沉浸) 快捷键控制 ----------------

    const RESERVED_KEYS = new Set(['Escape', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', ' ']);

    function formatKeyEvent(e) {
        const parts = [];
        if (e.ctrlKey) parts.push('Ctrl');
        if (e.altKey) parts.push('Alt');
        if (e.shiftKey) parts.push('Shift');
        if (e.metaKey) parts.push('Meta');

        const ignored = ['Control', 'Alt', 'Shift', 'Meta'];
        if (!ignored.includes(e.key)) {
            const keyName = e.key === ' ' ? 'Space' : (e.key.length === 1 ? e.key.toUpperCase() : e.key);
            parts.push(keyName);
        }
        return parts.join('+');
    }

    function togglePanel(forceOpen) {
        if (!state.videoActivated) return;
        ensureOverlayElements();
        if (!hudEl) return;
        state.panelOpen = typeof forceOpen === 'boolean' ? forceOpen : !state.panelOpen;
        hudEl.style.display = state.panelOpen ? 'block' : 'none';
        updateUI();
    }

    function toggleMiniPill(forceShow) {
        if (!state.videoActivated) return;
        ensureOverlayElements();
        settings.showMiniTrigger = typeof forceShow === 'boolean' ? forceShow : !settings.showMiniTrigger;
        saveSettings();
        if (!settings.showMiniTrigger && state.panelOpen) {
            state.panelOpen = false;
            if (hudEl) hudEl.style.display = 'none';
        }
        updateUI();
    }

    pageWin.addEventListener('keydown', function (e) {
        if (!state.videoActivated && !state.recordingTarget) return;

        if (state.recordingTarget) {
            e.preventDefault();
            e.stopImmediatePropagation();
            if (e.key === 'Escape') {
                state.recordingTarget = '';
                updateUI();
                return;
            }
            if (!e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey && RESERVED_KEYS.has(e.key)) {
                return;
            }
            const combo = formatKeyEvent(e);
            if (combo && !['Ctrl', 'Alt', 'Shift', 'Meta'].includes(combo)) {
                if (state.recordingTarget === 'panel') settings.hotkey = combo;
                if (state.recordingTarget === 'pill') settings.pillHotkey = combo;
                saveSettings();
                state.recordingTarget = '';
                updateUI();
            }
            return;
        }

        if (RESERVED_KEYS.has(e.key) && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
            return;
        }

        const pressed = formatKeyEvent(e);
        if (!pressed) return;

        if (pressed.toLowerCase() === settings.hotkey.toLowerCase()) {
            e.preventDefault();
            e.stopImmediatePropagation();
            togglePanel();
        } else if (pressed.toLowerCase() === settings.pillHotkey.toLowerCase()) {
            e.preventDefault();
            e.stopImmediatePropagation();
            toggleMiniPill();
        }
    }, true);

    function syncOverlayContainer() {
        const targetContainer = document.fullscreenElement || document.webkitFullscreenElement || document.body;
        if (!targetContainer) return;
        if (hudEl && hudEl.parentNode !== targetContainer) targetContainer.appendChild(hudEl);
        if (triggerEl && triggerEl.parentNode !== targetContainer) targetContainer.appendChild(triggerEl);
    }
    document.addEventListener('fullscreenchange', syncOverlayContainer);
    document.addEventListener('webkitfullscreenchange', syncOverlayContainer);

    if (typeof GM_registerMenuCommand === 'function') {
        GM_registerMenuCommand('打开/收起 主面板', () => {
            state.videoActivated = true;
            togglePanel();
        });
        GM_registerMenuCommand('显示/隐藏 右上角小胶囊', () => {
            state.videoActivated = true;
            toggleMiniPill();
        });
    }

    // ---------------- 11. UI 面板（精准触发换源提醒 + 绝不自动乱点切线） ----------------

    let hudEl = null;
    let triggerEl = null;
    let uiTimer = null;

    function scheduleUIUpdate() {
        if (!state.videoActivated) return;
        if (uiTimer) return;
        uiTimer = setTimeout(() => {
            uiTimer = null;
            updateUI();
        }, 350);
    }

    function stopMouseOnly(el) {
        ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick'].forEach((evt) => {
            el.addEventListener(evt, (e) => e.stopPropagation());
        });
        el.addEventListener('keydown', (e) => {
            if (e.target && e.target.tagName === 'INPUT') {
                e.stopPropagation();
            }
        });
    }

    function copySourceUrl() {
        if (!state.currentMediaUrl) return;
        try {
            if (typeof GM_setClipboard === 'function') {
                GM_setClipboard(state.currentMediaUrl, 'text');
            } else if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(state.currentMediaUrl);
            }
            state.copiedToast = true;
            updateUI();
            setTimeout(() => {
                state.copiedToast = false;
                updateUI();
            }, 1500);
        } catch {}
    }

    function applyPreset(mode) {
        if (mode === 'tv') {
            settings.maxCacheMemoryMB = 512;
            settings.maxMp4PullMB = 2048;
            settings.hlsSubThreads = 16;
            settings.hlsPrefetchAhead = 20;
            settings.mp4Threads = 20;
            settings.requestTimeoutMs = 25000;
            settings.reservoirMode = 'stream';
        } else if (mode === 'movie') {
            settings.maxCacheMemoryMB = 1024;
            settings.maxMp4PullMB = 3072;
            settings.hlsSubThreads = 18;
            settings.hlsPrefetchAhead = 28;
            settings.mp4Threads = 24;
            settings.requestTimeoutMs = 35000;
            settings.reservoirMode = 'stream';
        }
        saveSettings();
        updateUI();
    }

    function ensureOverlayElements() {
        if (!document.body) return;
        if (!hudEl) createHUD();
        if (!triggerEl) createMiniTrigger();
        syncOverlayContainer();
    }

    function createMiniTrigger() {
        if (triggerEl || !document.body) return;

        triggerEl = document.createElement('div');
        triggerEl.id = 'anime-cdn-mini-trigger';
        triggerEl.title = `点击展开面板 (${settings.hotkey}) | ${settings.pillHotkey} 隐藏胶囊`;
        triggerEl.style.display = (!state.panelOpen && settings.showMiniTrigger) ? 'flex' : 'none';
        triggerEl.innerHTML = `<span id="mini-dot"></span><span id="mini-label">CDN加速</span>`;

        stopMouseOnly(triggerEl);
        triggerEl.addEventListener('click', () => togglePanel(true));
        document.body.appendChild(triggerEl);
    }

    function createHUD() {
        if (hudEl || !document.body) return;

        GM_addStyle(`
            #anime-cdn-mini-trigger {
                position: fixed; top: 14px; right: 14px; z-index: 2147483647;
                display: flex; align-items: center; gap: 6px;
                background: rgba(15, 23, 42, 0.25); backdrop-filter: blur(4px);
                color: rgba(248, 250, 252, 0.85); font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
                font-size: 11px; font-weight: 600; padding: 4px 10px; border-radius: 999px;
                border: 1px solid rgba(255,255,255,0.12); cursor: pointer;
                opacity: 0.22; transition: opacity 0.2s, transform 0.15s, background 0.2s; user-select: none;
            }
            #anime-cdn-mini-trigger.alert-mode {
                opacity: 0.92; background: rgba(153, 27, 27, 0.9);
                border-color: rgba(248, 113, 113, 0.7); color: #fee2e2;
            }
            #anime-cdn-mini-trigger:hover { opacity: 0.95; transform: scale(1.03); background: rgba(15, 23, 42, 0.88); }
            #anime-cdn-mini-trigger #mini-dot { width: 6px; height: 6px; border-radius: 50%; background: #10b981; }

            #anime-cdn-hud {
                position: fixed; top: 14px; right: 14px; z-index: 2147483647;
                background: rgba(15, 23, 42, 0.92); backdrop-filter: blur(10px);
                color: #f8fafc; font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
                font-size: 12px; border-radius: 10px; padding: 10px 12px; width: 336px;
                box-shadow: 0 10px 30px rgba(0,0,0,0.55); border: 1px solid rgba(255,255,255,0.15);
                user-select: none;
            }
            #anime-cdn-hud * { box-sizing: border-box; }
            #anime-cdn-hud .hud-header {
                display: flex; justify-content: space-between; align-items: center;
                padding-bottom: 6px; margin-bottom: 8px; border-bottom: 1px solid rgba(255,255,255,0.1);
            }
            #anime-cdn-hud .hud-tabs { display: flex; gap: 4px; }
            #anime-cdn-hud .hud-tab {
                background: transparent; color: #94a3b8; border: none; border-radius: 4px;
                padding: 3px 8px; font-size: 11px; cursor: pointer;
            }
            #anime-cdn-hud .hud-tab.active { background: #334155; color: #fff; font-weight: 600; }
            #anime-cdn-hud .hud-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; gap: 6px; }
            #anime-cdn-hud .hud-badge { padding: 2px 6px; border-radius: 4px; font-weight: 600; font-size: 10px; color: #fff; }
            #anime-cdn-hud .hud-btn {
                background: #2563eb; color: #fff; border: none; border-radius: 5px;
                padding: 5px 6px; font-size: 11px; cursor: pointer; flex: 1; white-space: nowrap;
            }
            #anime-cdn-hud .hud-btn:hover { background: #1d4ed8; }
            #anime-cdn-hud .hud-btn.green { background: #059669; }
            #anime-cdn-hud .hud-btn.amber { background: #d97706; }
            #anime-cdn-hud .hud-btn.purple { background: #7c3aed; }
            #anime-cdn-hud .hud-btn.secondary { background: #334155; flex: 0 0 auto; padding: 5px 8px; }
            #anime-cdn-hud .hud-actions { display: flex; gap: 4px; margin-top: 8px; }
            #anime-cdn-hud .preset-row { display: flex; gap: 6px; margin-bottom: 8px; }
            #anime-cdn-hud .preset-btn {
                flex: 1; background: #1e293b; color: #cbd5e1; border: 1px solid #334155;
                border-radius: 5px; padding: 5px; font-size: 11px; cursor: pointer;
            }
            #anime-cdn-hud .preset-btn:hover { background: #334155; color: #fff; }
            #anime-cdn-hud .url-box { display: flex; align-items: center; gap: 4px; flex: 1; min-width: 0; }
            #anime-cdn-hud .url-input {
                flex: 1; min-width: 0; background: #0f172a; color: #94a3b8;
                border: 1px solid #334155; border-radius: 4px; padding: 2px 6px;
                font-size: 10px; font-family: monospace; user-select: text;
            }
            #anime-cdn-hud .advice-banner {
                background: rgba(220, 38, 38, 0.22); border: 1px solid rgba(248, 113, 113, 0.45);
                color: #fecaca; border-radius: 6px; padding: 5px 8px; font-size: 11px;
                margin-bottom: 6px; display: flex; justify-content: space-between; align-items: center; gap: 6px;
            }
            #anime-cdn-hud .res-bar-wrap {
                background: #1e293b; border-radius: 6px; height: 6px; overflow: hidden; margin: 4px 0 6px;
                border: 1px solid rgba(255,255,255,0.08);
            }
            #anime-cdn-hud .res-bar-fill {
                height: 100%; background: linear-gradient(90deg, #3b82f6, #10b981); width: 0%; transition: width 0.3s;
            }
            #anime-cdn-hud input[type="number"] {
                width: 68px; background: #1e293b; color: #f8fafc; border: 1px solid #475569;
                border-radius: 4px; padding: 2px 5px; font-size: 11px; text-align: right;
            }
            #anime-cdn-hud .hud-tip { color: #94a3b8; font-size: 10px; margin-top: 6px; line-height: 1.4; }
        `);

        hudEl = document.createElement('div');
        hudEl.id = 'anime-cdn-hud';
        hudEl.style.display = state.panelOpen ? 'block' : 'none';
        hudEl.innerHTML = `
            <div class="hud-header">
                <div class="hud-tabs">
                    <button id="tab-monitor" class="hud-tab active">监控</button>
                    <button id="tab-settings" class="hud-tab">设置</button>
                </div>
                <div style="display:flex;gap:4px;align-items:center;">
                    <span id="hud-codec-tag" class="hud-badge" style="background:#475569;display:none;"></span>
                    <span id="hud-cdn-tag" class="hud-badge">INIT</span>
                </div>
            </div>

            <div id="view-monitor">
                <div id="hud-advice-box" class="advice-banner" style="display:none;">
                    <span id="hud-advice-text">当前线路国际带宽过低，建议手动更换其他源</span>
                    <button id="hud-advice-close" class="hud-btn secondary" style="padding:1px 5px;font-size:10px;">忽略</button>
                </div>
                <div class="hud-row">
                    <span style="color:#94a3b8;">CDN 归属</span>
                    <span id="hud-cdn-name" style="max-width:195px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">-</span>
                </div>
                <div class="hud-row">
                    <span style="color:#94a3b8;">源地址</span>
                    <div class="url-box">
                        <input id="hud-source-url" class="url-input" type="text" readonly value="-" />
                        <button id="hud-btn-copy" class="hud-btn secondary" style="padding:2px 7px;font-size:10px;">复制</button>
                    </div>
                </div>
                <div class="hud-row">
                    <span style="color:#94a3b8;">瞬时 / 均速</span>
                    <div style="display:flex;align-items:center;gap:6px;">
                        <span id="hud-speed">-</span>
                        <button id="hud-btn-probe" class="hud-btn" style="flex:0 0 auto;padding:2px 7px;font-size:10px;">重测</button>
                    </div>
                </div>
                <div class="hud-row">
                    <span style="color:#94a3b8;">缓冲余量 / 延迟</span>
                    <span id="hud-buf">-</span>
                </div>
                <div id="hud-res-progress-box" style="display:none;">
                    <div class="hud-row" style="margin-bottom:2px;font-size:11px;">
                        <span style="color:#38bdf8;" id="hud-res-status">正在拉取...</span>
                        <span id="hud-res-pct">0%</span>
                    </div>
                    <div class="res-bar-wrap"><div id="hud-res-bar" class="res-bar-fill"></div></div>
                </div>
                <div class="hud-row">
                    <span style="color:#94a3b8;">并发与内存占用</span>
                    <span id="hud-prefetch">-</span>
                </div>
                <div class="hud-actions">
                    <button id="hud-btn-idm" class="hud-btn green">并发:开</button>
                    <button id="hud-btn-pull" class="hud-btn purple" title="全力多线程整集拉取到本地内存">整集拉取</button>
                    <button id="hud-btn-res" class="hud-btn amber">边蓄边播</button>
                    <button id="hud-btn-hide-pill" class="hud-btn secondary" title="连同小胶囊一起隐藏 (Alt+Q)">隐胶囊</button>
                    <button id="hud-btn-hide" class="hud-btn secondary">收起</button>
                </div>
                <div class="hud-tip" id="hud-hotkey-hint">${settings.hotkey} 面板 | ${settings.pillHotkey} 隐胶囊 | 放行ESC/方向键</div>
            </div>

            <div id="view-settings" style="display:none;">
                <div class="preset-row">
                    <button id="preset-tv" class="preset-btn">日常番剧 (512MB)</button>
                    <button id="preset-movie" class="preset-btn">剧场版 / 高波动 (1GB)</button>
                </div>
                <div class="hud-row">
                    <span style="color:#cbd5e1;">面板快捷键 (点击录制)</span>
                    <button id="set-hotkey-btn" class="hud-btn secondary" style="min-width:86px;">${settings.hotkey}</button>
                </div>
                <div class="hud-row">
                    <span style="color:#cbd5e1;">小胶囊快捷键 (点击录制)</span>
                    <button id="set-pill-hotkey-btn" class="hud-btn secondary" style="min-width:86px;">${settings.pillHotkey}</button>
                </div>
                <div class="hud-row">
                    <span style="color:#cbd5e1;">显示右上角高透明小胶囊</span>
                    <input type="checkbox" id="set-show-trigger" ${settings.showMiniTrigger ? 'checked' : ''} />
                </div>
                <div class="hud-row">
                    <span style="color:#cbd5e1;">慢速直链自动后台整集拉取</span>
                    <input type="checkbox" id="set-auto-pull" ${settings.autoPullSlowMp4 ? 'checked' : ''} />
                </div>
                <div class="hud-row">
                    <span style="color:#cbd5e1;">HLS 内存缓存上限 (MB)</span>
                    <input type="number" id="set-max-mem" min="128" max="2048" step="64" value="${settings.maxCacheMemoryMB}" />
                </div>
                <div class="hud-row">
                    <span style="color:#cbd5e1;">剧场版/整集拉取上限 (MB)</span>
                    <input type="number" id="set-max-mp4" min="512" max="4096" step="256" value="${settings.maxMp4PullMB}" />
                </div>
                <div class="hud-row">
                    <span style="color:#cbd5e1;">HLS 慢源全力线程数</span>
                    <input type="number" id="set-hls-threads" min="1" max="20" value="${settings.hlsSubThreads}" />
                </div>
                <div class="hud-row">
                    <span style="color:#cbd5e1;">整集拉取最大线程数</span>
                    <input type="number" id="set-mp4-threads" min="1" max="24" value="${settings.mp4Threads}" />
                </div>
                <div class="hud-row">
                    <span style="color:#cbd5e1;">代理高波动超时 (ms)</span>
                    <input type="number" id="set-timeout" min="5000" max="60000" step="1000" value="${settings.requestTimeoutMs}" />
                </div>
                <div class="hud-actions">
                    <button id="set-save-btn" class="hud-btn green">保存设置</button>
                    <button id="set-clear-btn" class="hud-btn secondary">清缓存</button>
                    <button id="set-back-btn" class="hud-btn secondary">返回</button>
                </div>
            </div>
        `;

        stopMouseOnly(hudEl);
        document.body.appendChild(hudEl);

        document.getElementById('tab-monitor').addEventListener('click', () => {
            state.activeTab = 'monitor';
            updateUI();
        });
        document.getElementById('tab-settings').addEventListener('click', () => {
            state.activeTab = 'settings';
            updateUI();
        });

        document.getElementById('hud-advice-close').addEventListener('click', () => {
            state.adviceDismissed = true;
            updateUI();
        });
        document.getElementById('hud-btn-copy').addEventListener('click', copySourceUrl);
        document.getElementById('hud-btn-probe').addEventListener('click', probeActiveSpeed);
        document.getElementById('hud-btn-idm').addEventListener('click', () => {
            state.hlsPrefetchEnabled = !state.hlsPrefetchEnabled;
            if (state.hlsPrefetchEnabled) state.bypassInterception = false;
            updateUI();
        });
        document.getElementById('hud-btn-pull').addEventListener('click', () => {
            if (state.mediaType === 'hls' || state.playlistSegments.length > 0) {
                toggleHlsFullPull();
            } else {
                startIdmMp4Download(false);
            }
        });
        document.getElementById('hud-btn-res').addEventListener('click', () => {
            const order = ['stream', 'pause', 'off'];
            const next = order[(order.indexOf(settings.reservoirMode) + 1) % order.length];
            settings.reservoirMode = next;
            if (next !== 'pause') {
                state.isReservoirPaused = false;
                const v = document.querySelector('video');
                if (v && v.paused) v.play().catch(() => {});
            }
            saveSettings();
            updateUI();
        });
        document.getElementById('hud-btn-hide-pill').addEventListener('click', () => toggleMiniPill(false));
        document.getElementById('hud-btn-hide').addEventListener('click', () => togglePanel(false));

        document.getElementById('preset-tv').addEventListener('click', () => applyPreset('tv'));
        document.getElementById('preset-movie').addEventListener('click', () => applyPreset('movie'));

        document.getElementById('set-hotkey-btn').addEventListener('click', () => {
            state.recordingTarget = 'panel';
            updateUI();
        });
        document.getElementById('set-pill-hotkey-btn').addEventListener('click', () => {
            state.recordingTarget = 'pill';
            updateUI();
        });

        document.getElementById('set-save-btn').addEventListener('click', () => {
            settings.showMiniTrigger = document.getElementById('set-show-trigger').checked;
            settings.autoPullSlowMp4 = document.getElementById('set-auto-pull').checked;
            settings.maxCacheMemoryMB = Math.max(128, Math.min(2048, Number(document.getElementById('set-max-mem').value) || 512));
            settings.maxMp4PullMB = Math.max(512, Math.min(4096, Number(document.getElementById('set-max-mp4').value) || 2048));
            settings.hlsSubThreads = Math.max(1, Math.min(20, Number(document.getElementById('set-hls-threads').value) || 16));
            settings.mp4Threads = Math.max(1, Math.min(24, Number(document.getElementById('set-mp4-threads').value) || 20));
            settings.requestTimeoutMs = Math.max(5000, Math.min(60000, Number(document.getElementById('set-timeout').value) || 25000));
            saveSettings();
            state.activeTab = 'monitor';
            updateUI();
        });

        document.getElementById('set-clear-btn').addEventListener('click', clearAllEpisodeMemory);
        document.getElementById('set-back-btn').addEventListener('click', () => {
            state.activeTab = 'monitor';
            updateUI();
        });
    }

    function updateUI() {
        if (!state.videoActivated) return;
        ensureOverlayElements();
        if (!hudEl) return;

        // 精准换源提醒条件：不再受 bufferAheadSec < 1 的死板限制，只要极慢且卡顿或延迟极高即提醒
        const isDeadSlow = !state.adviceDismissed && !state.activeBlobUrl && (
            (state.avgSpeedKBps > 0 && state.avgSpeedKBps < 280 && (state.stallCount >= 2 || state.ttfbMs >= 1500)) ||
            (state.stallCount >= 3 && state.bufferAheadSec < 2)
        );

        if (triggerEl) {
            const shouldShowPill = !state.panelOpen && (settings.showMiniTrigger || isDeadSlow);
            triggerEl.style.display = shouldShowPill ? 'flex' : 'none';
            triggerEl.classList.toggle('alert-mode', isDeadSlow);

            const miniDot = document.getElementById('mini-dot');
            const miniLabel = document.getElementById('mini-label');
            if (miniDot) miniDot.style.background = isDeadSlow ? '#fca5a5' : (state.mp4Downloading || state.hlsFullPulling ? '#38bdf8' : state.detectedCdn.color);
            if (miniLabel) {
                if (isDeadSlow) {
                    miniLabel.textContent = `⚠ 国际线路极差 (${state.avgSpeedKBps || state.lastSpeedKBps}K) 建议换源`;
                } else if (state.mp4Downloading) {
                    miniLabel.textContent = `拉取 ${state.mp4Progress}%`;
                } else if (state.hlsFullPulling && state.playlistSegments.length > 0) {
                    const pct = Math.round((state.segmentCache.size / state.playlistSegments.length) * 100);
                    miniLabel.textContent = `全拉 ${pct}%`;
                } else if (state.isReservoirPaused) {
                    const pct = Math.min(100, Math.round((state.bufferAheadSec / settings.reservoirResumeSec) * 100));
                    miniLabel.textContent = `蓄水 ${pct}%`;
                } else {
                    miniLabel.textContent = state.lastSpeedKBps > 0
                        ? `${state.detectedCdn.tag} ${state.lastSpeedKBps}K`
                        : 'CDN加速';
                }
            }
        }

        if (!state.panelOpen) return;

        const viewMonitor = document.getElementById('view-monitor');
        const viewSettings = document.getElementById('view-settings');
        const tabMonitor = document.getElementById('tab-monitor');
        const tabSettings = document.getElementById('tab-settings');

        if (state.activeTab === 'settings') {
            viewMonitor.style.display = 'none';
            viewSettings.style.display = 'block';
            tabMonitor.classList.remove('active');
            tabSettings.classList.add('active');
            const hkBtn = document.getElementById('set-hotkey-btn');
            const pillHkBtn = document.getElementById('set-pill-hotkey-btn');
            if (hkBtn) hkBtn.textContent = state.recordingTarget === 'panel' ? '请按下按键...' : settings.hotkey;
            if (pillHkBtn) pillHkBtn.textContent = state.recordingTarget === 'pill' ? '请按下按键...' : settings.pillHotkey;
            document.getElementById('set-show-trigger').checked = settings.showMiniTrigger;
            document.getElementById('set-auto-pull').checked = settings.autoPullSlowMp4;
            document.getElementById('set-max-mem').value = settings.maxCacheMemoryMB;
            document.getElementById('set-max-mp4').value = settings.maxMp4PullMB;
            document.getElementById('set-hls-threads').value = settings.hlsSubThreads;
            document.getElementById('set-mp4-threads').value = settings.mp4Threads;
            document.getElementById('set-timeout').value = settings.requestTimeoutMs;
            return;
        }

        viewMonitor.style.display = 'block';
        viewSettings.style.display = 'none';
        tabMonitor.classList.add('active');
        tabSettings.classList.remove('active');

        const adviceBox = document.getElementById('hud-advice-box');
        const adviceText = document.getElementById('hud-advice-text');
        if (adviceBox) {
            if (isDeadSlow) {
                adviceBox.style.display = 'flex';
                adviceText.textContent = `并发后仍仅 ${state.avgSpeedKBps} KB/s (延迟${state.ttfbMs}ms)，线路过差建议手动换源`;
            } else if (state.bypassInterception) {
                adviceBox.style.display = 'flex';
                adviceText.textContent = `检测到播放器不兼容接管，已自动回退原生直连`;
            } else {
                adviceBox.style.display = 'none';
            }
        }

        const tagEl = document.getElementById('hud-cdn-tag');
        const codecEl = document.getElementById('hud-codec-tag');
        const nameEl = document.getElementById('hud-cdn-name');
        const urlInput = document.getElementById('hud-source-url');
        const copyBtn = document.getElementById('hud-btn-copy');
        const speedEl = document.getElementById('hud-speed');
        const bufEl = document.getElementById('hud-buf');
        const prefetchEl = document.getElementById('hud-prefetch');
        const probeBtn = document.getElementById('hud-btn-probe');
        const idmBtn = document.getElementById('hud-btn-idm');
        const pullBtn = document.getElementById('hud-btn-pull');
        const resBtn = document.getElementById('hud-btn-res');
        const resBox = document.getElementById('hud-res-progress-box');
        const resBar = document.getElementById('hud-res-bar');
        const resPct = document.getElementById('hud-res-pct');
        const resStatus = document.getElementById('hud-res-status');
        const hintEl = document.getElementById('hud-hotkey-hint');

        tagEl.textContent = state.detectedCdn.tag;
        tagEl.style.background = state.detectedCdn.color;
        if (state.codecHint) {
            codecEl.textContent = state.codecHint;
            codecEl.style.display = 'inline-block';
        }
        nameEl.textContent = state.detectedCdn.name;
        nameEl.title = state.currentMediaUrl || '';
        if (urlInput) urlInput.value = state.currentMediaUrl || '等待捕获源地址...';
        if (copyBtn) copyBtn.textContent = state.copiedToast ? '已复制✓' : '复制';

        const speedColor = state.avgSpeedKBps > 0 && state.avgSpeedKBps < settings.lowSpeedThresholdKBps ? '#f87171' : '#34d399';
        speedEl.innerHTML = `<span style="color:${speedColor};font-weight:600;">${state.lastSpeedKBps} KB/s</span> / ${state.avgSpeedKBps} KB/s`;

        const targetRes = settings.reservoirResumeSec;
        bufEl.textContent = `${state.bufferAheadSec}s / ${state.ttfbMs}ms (卡${state.stallCount})`;

        const memMB = (state.cacheBytesUsed / (1024 * 1024)).toFixed(1);
        if (state.mp4Downloading) {
            const dlMB = (state.mp4DownloadedBytes / (1024 * 1024)).toFixed(1);
            const totMB = (state.mp4TotalBytes / (1024 * 1024)).toFixed(1);
            resBox.style.display = 'block';
            resBar.style.width = `${state.mp4Progress}%`;
            resPct.textContent = `${dlMB}/${totMB}MB (${state.mp4Progress}%)`;
            resStatus.textContent = `整集拉取中 ${state.mp4CombinedSpeedKBps} KB/s`;
        } else if (state.hlsFullPulling && state.playlistSegments.length > 0) {
            const pct = Math.min(100, Math.round((state.segmentCache.size / state.playlistSegments.length) * 100));
            resBox.style.display = 'block';
            resBar.style.width = `${pct}%`;
            resPct.textContent = `${state.segmentCache.size}/${state.playlistSegments.length}片 (${memMB}MB)`;
            resStatus.textContent = state.isReservoirPaused
                ? `蓄水暂停中 + 全拉 ${pct}%`
                : `HLS全力缓存中 (${pct}%)`;
        } else if (state.isReservoirPaused) {
            const pct = Math.min(100, Math.round((state.bufferAheadSec / targetRes) * 100));
            resBox.style.display = 'block';
            resBar.style.width = `${pct}%`;
            resPct.textContent = `${state.bufferAheadSec}/${targetRes}s (${pct}%)`;
            resStatus.textContent = '暂停蓄水中，满后自动播';
        } else {
            resBox.style.display = 'none';
        }

        const mp4MemMB = (state.mp4DownloadedBytes / (1024 * 1024)).toFixed(1);
        const mp4TotMB = (state.mp4TotalBytes / (1024 * 1024)).toFixed(1);

        if (state.isLiveStream) {
            prefetchEl.textContent = '直播流 (已跳过预缓存)';
            idmBtn.style.display = 'none';
            pullBtn.style.display = 'none';
        } else if (state.mediaType === 'mp4') {
            if (state.mp4Downloading) {
                prefetchEl.textContent = `${state.mp4ActiveThreads}线程 | ${mp4MemMB}/${mp4TotMB}MB`;
            } else if (state.activeBlobUrl) {
                prefetchEl.textContent = `本地Blob ${mp4TotMB || mp4MemMB}MB (0卡顿)`;
            } else {
                prefetchEl.textContent = `${settings.mp4Threads}线程待命 | ${memMB}/${settings.maxCacheMemoryMB}MB`;
            }
            idmBtn.style.display = 'none';
            pullBtn.style.display = 'block';
            pullBtn.textContent = state.mp4Downloading ? `${state.mp4Progress}%` : (state.activeBlobUrl ? '已本地化' : '整集拉取');
        } else {
            const policy = getAdaptiveHlsPolicy();
            idmBtn.style.display = 'block';
            pullBtn.style.display = 'block';
            pullBtn.textContent = state.hlsFullPulling ? '停止全拉' : '整集拉取';
            const splitInfo = state.bypassInterception ? '直连兜底' : (state.hlsRangeSplitSupported === false ? '无Range' : policy.modeLabel);
            prefetchEl.textContent = state.hlsPrefetchEnabled
                ? `${splitInfo} | ${memMB}/${settings.maxCacheMemoryMB}MB`
                : `预取暂停 | ${memMB}MB`;
            idmBtn.textContent = state.hlsPrefetchEnabled ? '并发:开' : '并发:关';
        }

        const resMap = { stream: '边蓄边播', pause: '暂停蓄水', off: '蓄水:关' };
        resBtn.textContent = resMap[settings.reservoirMode] || '边蓄边播';
        probeBtn.textContent = state.isProbing ? '测速中' : '重测';
        hintEl.textContent = `${settings.hotkey} 面板 | ${settings.pillHotkey} 隐胶囊 | 放行ESC/方向键`;
    }

    // ---------------- 12. 初始化与页面卸载内存清理 ----------------

    hookPageNetwork();
    startPerformanceMonitor();

    function scanForVideos() {
        const videos = document.querySelectorAll('video');
        if (videos.length > 0) {
            videos.forEach(bindVideoEvents);
        }
    }

    pageWin.addEventListener('DOMContentLoaded', () => {
        scanForVideos();
        const mo = new MutationObserver(scanForVideos);
        mo.observe(document.documentElement, { childList: true, subtree: true });
    });

    pageWin.addEventListener('pagehide', clearAllEpisodeMemory);
    pageWin.addEventListener('beforeunload', clearAllEpisodeMemory);
})();
