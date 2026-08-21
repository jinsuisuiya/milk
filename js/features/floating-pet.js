/**
 * 桌面悬浮桌宠 (Floating Desktop Pet) & 后台强力保活引擎
 * - 纯净桌面悬浮宠：常驻屏幕，支持跨窗口画中画 (PiP)
 * - 形象选择：对方头像(TA)、自定义上传图片/GIF动图
 * - 消息实时冒泡（无轮播）：收到对方消息时（如根据最短/最长等待时间回复），桌宠头顶跳出对方说的话，每条消息精准保留 2 秒钟后消失
 * - 强化后台保活系统：Web Worker 精确时钟 + Screen WakeLock + 无声心跳音频保活通道（确保切出网页后回复定时器不被系统降频冻结）
 */
(function (global) {
    'use strict';

    const STORAGE_KEY = 'CHAT_APP_V3_floating_pet_config';
    const KEEPALIVE_KEY = 'CHAT_APP_V3_keepalive_settings';

    // 默认桌宠配置
    const DEFAULT_PET_CONFIG = {
        enabled: false,
        avatarType: 'partner', // 'partner' | 'custom'
        customAvatarUrl: '',
        size: 56, // px (36 - 84)
        opacity: 0.95, // 0.3 - 1.0
        bubbleDuration: 2000, // 消息停留 2 秒
        posX: -1,
        posY: -1
    };

    // 默认后台保活配置
    const DEFAULT_KEEPALIVE_CONFIG = {
        workerTimerEnabled: true,   // Web Worker 独立精准计时 (防后台节流冻结)
        wakeLockEnabled: false,     // 屏幕常亮防休眠
        silentAudioEnabled: false   // 无声心跳音频通道 (防移动端切后台休眠)
    };

    // ==========================================
    // 1. 强化后台保活引擎 (Keep-Alive Engine)
    // ==========================================
    class KeepAliveEngine {
        constructor() {
            this.config = this.loadConfig();
            this.worker = null;
            this.wakeLock = null;
            this.audioCtx = null;
            this.silentSource = null;
            this.workerCallbacks = new Map();
            this.nextCallbackId = 1;

            this.init();
        }

        loadConfig() {
            try {
                const raw = localStorage.getItem(KEEPALIVE_KEY);
                if (raw) return Object.assign(DEFAULT_KEEPALIVE_CONFIG, JSON.parse(raw));
            } catch (e) {
                console.warn('[KeepAlive] 加载配置失败:', e);
            }
            return Object.assign({}, DEFAULT_KEEPALIVE_CONFIG);
        }

        saveConfig(partial) {
            this.config = Object.assign({}, this.config, partial);
            try {
                localStorage.setItem(KEEPALIVE_KEY, JSON.stringify(this.config));
            } catch (e) {}
            this.applySettings();
        }

        init() {
            this.initWebWorker();
            this.applySettings();

            // 监听前后台切换
            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'visible') {
                    if (this.config.wakeLockEnabled) this.requestWakeLock();
                }
            });
        }

        // 创建 Blob Web Worker，提供不被浏览器后台降频的精准定时器
        initWebWorker() {
            try {
                const workerCode = `
                    const timers = new Map();
                    self.onmessage = function(e) {
                        const { action, id, interval } = e.data;
                        if (action === 'start') {
                            if (timers.has(id)) clearInterval(timers.get(id));
                            const timerId = setInterval(() => {
                                self.postMessage({ id });
                            }, interval);
                            timers.set(id, timerId);
                        } else if (action === 'startOnce') {
                            if (timers.has(id)) clearTimeout(timers.get(id));
                            const timerId = setTimeout(() => {
                                self.postMessage({ id });
                                timers.delete(id);
                            }, interval);
                            timers.set(id, timerId);
                        } else if (action === 'stop') {
                            if (timers.has(id)) {
                                clearInterval(timers.get(id));
                                clearTimeout(timers.get(id));
                                timers.delete(id);
                            }
                        }
                    };
                `;
                const blob = new Blob([workerCode], { type: 'application/javascript' });
                this.worker = new Worker(URL.createObjectURL(blob));
                this.worker.onmessage = (e) => {
                    const { id } = e.data;
                    const cb = this.workerCallbacks.get(id);
                    if (typeof cb === 'function') cb();
                };
            } catch (e) {
                console.warn('[KeepAlive] Web Worker 初始化失败，回退到主线程定时器:', e);
                this.worker = null;
            }
        }

        // 注册不降频的单次定时任务 (setTimeout)
        registerWorkerTimeout(fn, delayMs) {
            const id = this.nextCallbackId++;
            const wrapper = () => {
                this.workerCallbacks.delete(id);
                fn();
            };
            this.workerCallbacks.set(id, wrapper);
            if (this.worker && this.config.workerTimerEnabled) {
                this.worker.postMessage({ action: 'startOnce', id, interval: Math.max(0, delayMs) });
            } else {
                const tId = setTimeout(wrapper, delayMs);
                this.workerCallbacks.set(`fallback_${id}`, tId);
            }
            return id;
        }

        // 注册不降频的循环定时任务 (setInterval)
        registerWorkerInterval(fn, intervalMs) {
            const id = this.nextCallbackId++;
            this.workerCallbacks.set(id, fn);
            if (this.worker && this.config.workerTimerEnabled) {
                this.worker.postMessage({ action: 'start', id, interval: intervalMs });
            } else {
                const tId = setInterval(fn, intervalMs);
                this.workerCallbacks.set(`fallback_${id}`, tId);
            }
            return id;
        }

        clearWorkerInterval(id) {
            this.workerCallbacks.delete(id);
            if (this.worker) {
                this.worker.postMessage({ action: 'stop', id });
            }
            const fallbackId = this.workerCallbacks.get(`fallback_${id}`);
            if (fallbackId) {
                clearInterval(fallbackId);
                clearTimeout(fallbackId);
                this.workerCallbacks.delete(`fallback_${id}`);
            }
        }

        // Screen WakeLock: 防止手机/平板屏幕变暗或锁屏休眠
        async requestWakeLock() {
            if ('wakeLock' in navigator) {
                try {
                    this.wakeLock = await navigator.wakeLock.request('screen');
                    this.wakeLock.addEventListener('release', () => {
                        this.wakeLock = null;
                    });
                } catch (err) {
                    console.warn('[KeepAlive] WakeLock 申请失败:', err);
                }
            }
        }

        releaseWakeLock() {
            if (this.wakeLock) {
                this.wakeLock.release().catch(() => {});
                this.wakeLock = null;
            }
        }

        // 无声声波循环保活 (Silent Audio Loop)
        startSilentAudio() {
            try {
                const AudioContext = window.AudioContext || window.webkitAudioContext;
                if (!AudioContext) return;
                if (!this.audioCtx) {
                    this.audioCtx = new AudioContext();
                }
                if (this.audioCtx.state === 'suspended') {
                    this.audioCtx.resume().catch(() => {});
                }
                if (this.silentSource) return;

                // 创建极微人耳不可闻音量振荡器，确保被移动端系统识别为活跃音频会话
                const osc = this.audioCtx.createOscillator();
                const gain = this.audioCtx.createGain();
                osc.type = 'sine';
                osc.frequency.setValueAtTime(440, this.audioCtx.currentTime);
                gain.gain.setValueAtTime(0.0001, this.audioCtx.currentTime);
                osc.connect(gain);
                gain.connect(this.audioCtx.destination);
                osc.start();
                this.silentSource = osc;
            } catch (e) {
                console.warn('[KeepAlive] 无声音频保活启动失败:', e);
            }
        }

        stopSilentAudio() {
            if (this.silentSource) {
                try { this.silentSource.stop(); } catch (e) {}
                this.silentSource = null;
            }
        }

        applySettings() {
            if (this.config.wakeLockEnabled) {
                this.requestWakeLock();
            } else {
                this.releaseWakeLock();
            }

            if (this.config.silentAudioEnabled) {
                this.startSilentAudio();
            } else {
                this.stopSilentAudio();
            }
        }
    }

    const keepAlive = new KeepAliveEngine();
    global.KeepAliveEngine = keepAlive;
    global._preciseTimeout = (fn, delay) => keepAlive.registerWorkerTimeout(fn, delay);
    global._clearPreciseTimeout = (id) => keepAlive.clearWorkerInterval(id);

    // ==========================================
    // 2. 桌面悬浮桌宠引擎 (Floating Pet Widget)
    // ==========================================
    class FloatingPetWidget {
        constructor() {
            this.config = this.loadConfig();
            this.widgetEl = null;
            this.bubbleEl = null;
            this.avatarEl = null;
            this.pipWindow = null;
            this.isDragging = false;
            this.currentX = 0;
            this.currentY = 0;
            this.bubbleTimer = null;
            this.messageQueue = [];
            this.isProcessingQueue = false;

            this.init();
        }

        loadConfig() {
            try {
                const raw = localStorage.getItem(STORAGE_KEY);
                if (raw) return Object.assign({}, DEFAULT_PET_CONFIG, JSON.parse(raw));
            } catch (e) {
                console.warn('[FloatingPet] 读取配置失败:', e);
            }
            return Object.assign({}, DEFAULT_PET_CONFIG);
        }

        saveConfig(partial) {
            this.config = Object.assign({}, this.config, partial);
            try {
                localStorage.setItem(STORAGE_KEY, JSON.stringify(this.config));
            } catch (e) {}
            this.applyConfig();
        }

        init() {
            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', () => this.mount());
            } else {
                this.mount();
            }
        }

        mount() {
            if (document.getElementById('floating-pet-widget')) return;
            this.injectTransparentStyles();
            this.createWidgetDOM();
            this.applyConfig();
            this.bindWindowEvents();
            this.listenToNewMessages();
        }

        injectTransparentStyles() {
            if (document.getElementById('floating-pet-global-override-style')) return;
            const style = document.createElement('style');
            style.id = 'floating-pet-global-override-style';
            style.textContent = `
                #floating-pet-widget,
                #floating-pet-widget *,
                #floating-pet-avatar-wrap,
                .floating-pet-avatar-wrap,
                .floating-pet-avatar-img,
                .floating-pet-badge,
                .floating-pet-bubble,
                .pet-bubble-text {
                    -webkit-tap-highlight-color: transparent !important;
                    -webkit-tap-highlight-color: rgba(0,0,0,0) !important;
                    -webkit-touch-callout: none !important;
                    -webkit-user-select: none !important;
                    user-select: none !important;
                    -webkit-user-drag: none !important;
                    outline: none !important;
                    border-color: inherit;
                }
                #floating-pet-avatar-wrap {
                    background: transparent !important;
                    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.25) !important;
                    -webkit-tap-highlight-color: transparent !important;
                    -webkit-tap-highlight-color: rgba(0,0,0,0) !important;
                }
                .floating-pet-avatar-img {
                    background: transparent !important;
                    mix-blend-mode: normal !important;
                    filter: none !important;
                    pointer-events: none !important;
                    display: block !important;
                    -webkit-user-drag: none !important;
                    -webkit-touch-callout: none !important;
                }
                #floating-pet-widget:active,
                #floating-pet-widget:focus,
                #floating-pet-widget:hover,
                #floating-pet-avatar-wrap:active,
                #floating-pet-avatar-wrap:focus,
                #floating-pet-avatar-wrap:hover,
                .floating-pet-avatar-img:active,
                .floating-pet-avatar-img:focus {
                    outline: none !important;
                    background: transparent !important;
                    -webkit-tap-highlight-color: transparent !important;
                    -webkit-tap-highlight-color: rgba(0,0,0,0) !important;
                }
                #floating-pet-widget::before,
                #floating-pet-widget::after,
                #floating-pet-avatar-wrap::before,
                #floating-pet-avatar-wrap::after {
                    display: none !important;
                    content: none !important;
                }
            `;
            document.head.appendChild(style);
        }

        createWidgetDOM() {
            const widget = document.createElement('div');
            widget.id = 'floating-pet-widget';
            widget.className = 'floating-pet-root';
            widget.style.cssText = `
                position: fixed;
                z-index: 99999;
                display: none;
                flex-direction: column;
                align-items: center;
                cursor: grab;
                user-select: none;
                -webkit-user-select: none;
                touch-action: none;
                -webkit-tap-highlight-color: transparent;
                -webkit-touch-callout: none;
                transition: transform 0.22s cubic-bezier(0.2, 0.9, 0.3, 1.2), opacity 0.2s ease;
            `;

            // 消息跳出冒泡气泡 (每条保留 2 秒)
            const bubble = document.createElement('div');
            bubble.id = 'floating-pet-bubble';
            bubble.className = 'floating-pet-bubble';
            bubble.style.cssText = `
                position: absolute;
                bottom: calc(100% + 12px);
                max-width: 230px;
                min-width: 80px;
                padding: 9px 13px;
                background: var(--secondary-bg, #ffffff);
                color: var(--text-primary, #333);
                border: 1px solid var(--border-color, rgba(0,0,0,0.12));
                border-radius: 16px;
                box-shadow: 0 8px 24px rgba(0, 0, 0, 0.15), 0 2px 6px rgba(0, 0, 0, 0.06);
                font-size: 13px;
                line-height: 1.45;
                letter-spacing: 0.2px;
                backdrop-filter: blur(16px);
                -webkit-backdrop-filter: blur(16px);
                pointer-events: none;
                visibility: hidden;
                opacity: 0;
                transform: translateY(8px) scale(0.92);
                transition: opacity 0.22s cubic-bezier(0.2, 0.9, 0.3, 1), transform 0.22s cubic-bezier(0.2, 0.9, 0.3, 1.2), visibility 0.22s;
                word-break: break-word;
                text-align: left;
                -webkit-tap-highlight-color: transparent;
                outline: none;
            `;

            // 气泡下箭头
            const arrow = document.createElement('div');
            arrow.className = 'floating-pet-arrow';
            arrow.style.cssText = `
                position: absolute;
                bottom: -6px;
                left: 50%;
                transform: translateX(-50%) rotate(45deg);
                width: 11px;
                height: 11px;
                background: var(--secondary-bg, #ffffff);
                border-right: 1px solid var(--border-color, rgba(0,0,0,0.12));
                border-bottom: 1px solid var(--border-color, rgba(0,0,0,0.12));
            `;
            bubble.appendChild(arrow);

            // 气泡内容
            const textSpan = document.createElement('div');
            textSpan.className = 'pet-bubble-text';
            textSpan.style.cssText = 'position: relative; z-index: 1; font-weight: 500;';
            bubble.appendChild(textSpan);

            // 桌宠头像外框容器 (无白底、无白罩、透明背景)
            const avatarWrap = document.createElement('div');
            avatarWrap.id = 'floating-pet-avatar-wrap';
            avatarWrap.className = 'floating-pet-avatar-wrap';
            avatarWrap.style.cssText = `
                position: relative;
                width: 56px;
                height: 56px;
                border-radius: 50%;
                display: flex;
                align-items: center;
                justify-content: center;
                background: transparent;
                box-shadow: 0 6px 18px rgba(0, 0, 0, 0.2);
                border: 2.5px solid var(--accent-color, #FF6B8B);
                overflow: visible;
                cursor: pointer;
                -webkit-tap-highlight-color: transparent !important;
                -webkit-tap-highlight-color: rgba(0,0,0,0) !important;
                -webkit-touch-callout: none;
                outline: none;
                user-select: none;
                -webkit-user-select: none;
                touch-action: none;
                transition: transform 0.16s cubic-bezier(0.3, 1.4, 0.5, 1);
            `;

            // 头像图像 (展示对方头像或自定义图片，透明底)
            const avatarImg = document.createElement('img');
            avatarImg.className = 'floating-pet-avatar-img';
            avatarImg.setAttribute('draggable', 'false');
            avatarImg.setAttribute('alt', '');
            avatarImg.style.cssText = `
                width: 100%;
                height: 100%;
                border-radius: 50%;
                object-fit: cover;
                pointer-events: none;
                background: transparent;
                display: block;
                -webkit-tap-highlight-color: transparent !important;
                -webkit-tap-highlight-color: rgba(0,0,0,0) !important;
                -webkit-user-drag: none;
                -webkit-touch-callout: none;
                user-select: none;
                -webkit-user-select: none;
            `;
            avatarWrap.appendChild(avatarImg);

            // 右下角互动小标记
            const badge = document.createElement('div');
            badge.className = 'floating-pet-badge';
            badge.style.cssText = `
                position: absolute;
                bottom: -2px;
                right: -2px;
                width: 17px;
                height: 17px;
                background: linear-gradient(135deg, var(--accent-color, #FF6B8B), #FF8E53);
                border: 2px solid #FFF;
                border-radius: 50%;
                display: flex;
                align-items: center;
                justify-content: center;
                color: #FFF;
                font-size: 8.5px;
                box-shadow: 0 2px 5px rgba(0,0,0,0.25);
                pointer-events: none;
            `;
            badge.innerHTML = '<i class="fas fa-heart"></i>';
            avatarWrap.appendChild(badge);

            widget.appendChild(bubble);
            widget.appendChild(avatarWrap);
            document.body.appendChild(widget);

            this.widgetEl = widget;
            this.bubbleEl = bubble;
            this.avatarEl = avatarWrap;

            this.bindDragEvents();
        }

        bindWindowEvents() {
            window.addEventListener('resize', () => {
                if (!this.config.enabled || !this.widgetEl) return;
                this.clampPosition();
            });
        }

        // 监听应用内收到的新消息并在头顶跳出，每条保留 2 秒（不要轮播）
        listenToNewMessages() {
            window.addEventListener('app-new-message-received', (e) => {
                if (!this.config.enabled) return;
                const msg = e.detail;
                if (!msg || msg.sender === 'user') return; // 只响应对方发送的消息

                let text = '';
                if (msg.type === 'normal' && msg.text) {
                    text = msg.text;
                } else if (msg.type === 'voice') {
                    text = '🎤 [语音消息]';
                } else if (msg.type === 'image') {
                    text = '🖼️ [发来了一张图片]';
                } else if (msg.type === 'sticker') {
                    text = '✨ [发来了一个表情]';
                }

                if (text) {
                    this.enqueueMessage(text);
                }
            });
        }

        // 入队新消息并顺序展示，每条保留 2 秒
        enqueueMessage(text) {
            this.messageQueue.push(text);
            if (!this.isProcessingQueue) {
                this.processMessageQueue();
            }
        }

        processMessageQueue() {
            if (this.messageQueue.length === 0) {
                this.isProcessingQueue = false;
                return;
            }

            this.isProcessingQueue = true;
            const nextText = this.messageQueue.shift();

            this.showBubble(nextText, 2000, () => {
                // 当前消息展示 2 秒淡出后，若队列中还有消息，间隔 200ms 后展示下一条
                setTimeout(() => {
                    this.processMessageQueue();
                }, 200);
            });
            this.wiggleAvatar();
            this.spawnHeartParticles();
        }

        bindDragEvents() {
            const el = this.widgetEl;
            let startX = 0, startY = 0;
            let origLeft = 0, origTop = 0;
            let isMoved = false;

            const handleStart = (clientX, clientY, e) => {
                if (e && e.cancelable) {
                    e.preventDefault();
                }
                this.isDragging = true;
                isMoved = false;
                el.style.cursor = 'grabbing';
                el.style.transition = 'none';

                startX = clientX;
                startY = clientY;

                const rect = el.getBoundingClientRect();
                origLeft = rect.left;
                origTop = rect.top;

                window.addEventListener('pointermove', onPointerMove, { passive: false });
                window.addEventListener('pointerup', onPointerUp);
                window.addEventListener('pointercancel', onPointerUp);
                window.addEventListener('touchmove', onTouchMove, { passive: false });
                window.addEventListener('touchend', onTouchEnd);
                window.addEventListener('touchcancel', onTouchEnd);
            };

            const handleMove = (clientX, clientY, e) => {
                if (!this.isDragging) return;
                if (e && e.cancelable) {
                    e.preventDefault();
                }
                const dx = clientX - startX;
                const dy = clientY - startY;

                if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
                    isMoved = true;
                }

                let newLeft = origLeft + dx;
                let newTop = origTop + dy;

                const size = this.config.size || 56;
                const maxLeft = window.innerWidth - size - 8;
                const maxTop = window.innerHeight - size - 8;

                newLeft = Math.max(8, Math.min(newLeft, maxLeft));
                newTop = Math.max(8, Math.min(newTop, maxTop));

                el.style.left = `${newLeft}px`;
                el.style.top = `${newTop}px`;
                el.style.right = 'auto';
                el.style.bottom = 'auto';

                this.currentX = newLeft;
                this.currentY = newTop;
            };

            const handleEnd = (e) => {
                if (!this.isDragging) return;
                this.isDragging = false;
                el.style.cursor = 'grab';
                el.style.transition = 'transform 0.22s cubic-bezier(0.2, 0.9, 0.3, 1.2), left 0.3s cubic-bezier(0.2, 0.9, 0.3, 1.2), top 0.3s ease';

                window.removeEventListener('pointermove', onPointerMove);
                window.removeEventListener('pointerup', onPointerUp);
                window.removeEventListener('pointercancel', onPointerUp);
                window.removeEventListener('touchmove', onTouchMove);
                window.removeEventListener('touchend', onTouchEnd);
                window.removeEventListener('touchcancel', onTouchEnd);

                this.saveConfig({ posX: this.currentX, posY: this.currentY });

                if (!isMoved) {
                    this.handleAvatarClick();
                }
            };

            const onPointerDown = (e) => {
                if (e.pointerType === 'touch') return; // touchstart will handle touch to avoid double triggers
                handleStart(e.clientX, e.clientY, e);
            };

            const onPointerMove = (e) => {
                handleMove(e.clientX, e.clientY, e);
            };

            const onPointerUp = (e) => {
                handleEnd(e);
            };

            const onTouchStart = (e) => {
                if (e.touches && e.touches.length > 0) {
                    handleStart(e.touches[0].clientX, e.touches[0].clientY, e);
                }
            };

            const onTouchMove = (e) => {
                if (e.touches && e.touches.length > 0) {
                    handleMove(e.touches[0].clientX, e.touches[0].clientY, e);
                }
            };

            const onTouchEnd = (e) => {
                handleEnd(e);
            };

            this.avatarEl.addEventListener('pointerdown', onPointerDown);
            this.avatarEl.addEventListener('touchstart', onTouchStart, { passive: false });
            this.avatarEl.addEventListener('contextmenu', (e) => e.preventDefault());
            this.avatarEl.addEventListener('dragstart', (e) => e.preventDefault());
            if (this.widgetEl) {
                this.widgetEl.addEventListener('contextmenu', (e) => e.preventDefault());
            }
        }

        // 点击/戳一戳互动：展示对方上一句消息或心动回应，保留 2 秒
        handleAvatarClick() {
            this.wiggleAvatar();
            this.spawnHeartParticles();

            // 优先查找对方发过的最后一条消息
            let replyText = '';
            if (typeof messages !== 'undefined' && Array.isArray(messages)) {
                const partnerMsgs = messages.filter(m => m && m.type === 'normal' && m.text && m.sender !== 'user');
                if (partnerMsgs.length > 0) {
                    replyText = partnerMsgs[partnerMsgs.length - 1].text;
                }
            }

            if (!replyText) {
                const partnerName = typeof settings !== 'undefined' ? (settings.partnerName || 'TA') : 'TA';
                replyText = `${partnerName} 正在想你哦✨`;
            }

            this.showBubble(replyText, 2000);
        }

        wiggleAvatar() {
            if (!this.avatarEl) return;
            this.avatarEl.style.transform = 'scale(0.86) rotate(-8deg)';
            setTimeout(() => {
                this.avatarEl.style.transform = 'scale(1.18) rotate(8deg)';
                setTimeout(() => {
                    this.avatarEl.style.transform = 'scale(1)';
                }, 130);
            }, 90);
        }

        spawnHeartParticles() {
            if (!this.avatarEl) return;
            const rect = this.avatarEl.getBoundingClientRect();
            const centerX = rect.left + rect.width / 2;
            const centerY = rect.top + rect.height / 2;

            const icons = ['✨', '💖', '⭐', '🌸', '💫', '💕'];
            for (let i = 0; i < 4; i++) {
                const particle = document.createElement('div');
                particle.textContent = icons[Math.floor(Math.random() * icons.length)];
                particle.style.cssText = `
                    position: fixed;
                    left: ${centerX}px;
                    top: ${centerY}px;
                    font-size: ${14 + Math.random() * 8}px;
                    pointer-events: none;
                    z-index: 100000;
                    transform: translate(-50%, -50%);
                    opacity: 1;
                    transition: all 0.65s cubic-bezier(0.1, 0.8, 0.3, 1);
                `;
                document.body.appendChild(particle);

                const angle = Math.random() * Math.PI * 2;
                const dist = 35 + Math.random() * 40;
                const tx = Math.cos(angle) * dist;
                const ty = Math.sin(angle) * dist - 25;

                requestAnimationFrame(() => {
                    particle.style.transform = `translate(calc(-50% + ${tx}px), calc(-50% + ${ty}px)) scale(1.35)`;
                    particle.style.opacity = '0';
                });
                setTimeout(() => particle.remove(), 700);
            }
        }

        // 显示气泡并在 durationMs (默认 2000ms) 后自动收起
        showBubble(text, durationMs = 2000, onDone = null) {
            if (!this.bubbleEl || !this.widgetEl) return;
            const textSpan = this.bubbleEl.querySelector('.pet-bubble-text');
            if (textSpan) textSpan.textContent = text;

            // 边界防溢出翻转
            const rect = this.widgetEl.getBoundingClientRect();
            if (rect.top < 110) {
                this.bubbleEl.style.bottom = 'auto';
                this.bubbleEl.style.top = 'calc(100% + 12px)';
                const arrow = this.bubbleEl.querySelector('.floating-pet-arrow');
                if (arrow) {
                    arrow.style.bottom = 'auto';
                    arrow.style.top = '-6px';
                    arrow.style.borderRight = 'none';
                    arrow.style.borderBottom = 'none';
                    arrow.style.borderLeft = '1px solid var(--border-color, rgba(0,0,0,0.12))';
                    arrow.style.borderTop = '1px solid var(--border-color, rgba(0,0,0,0.12))';
                }
            } else {
                this.bubbleEl.style.top = 'auto';
                this.bubbleEl.style.bottom = 'calc(100% + 12px)';
                const arrow = this.bubbleEl.querySelector('.floating-pet-arrow');
                if (arrow) {
                    arrow.style.top = 'auto';
                    arrow.style.bottom = '-6px';
                    arrow.style.borderLeft = 'none';
                    arrow.style.borderTop = 'none';
                    arrow.style.borderRight = '1px solid var(--border-color, rgba(0,0,0,0.12))';
                    arrow.style.borderBottom = '1px solid var(--border-color, rgba(0,0,0,0.12))';
                }
            }

            this.bubbleEl.style.visibility = 'visible';
            this.bubbleEl.style.opacity = '1';
            this.bubbleEl.style.transform = 'translateY(0) scale(1)';

            // 画中画同步展示 2 秒
            if (this.pipWindow && this.pipBubbleEl) {
                this.pipBubbleEl.textContent = text;
                this.pipBubbleEl.style.opacity = '1';
            }

            if (this.bubbleTimer) clearTimeout(this.bubbleTimer);
            this.bubbleTimer = setTimeout(() => {
                this.hideBubble();
                if (typeof onDone === 'function') onDone();
            }, durationMs);
        }

        hideBubble() {
            if (!this.bubbleEl) return;
            this.bubbleEl.style.opacity = '0';
            this.bubbleEl.style.transform = 'translateY(8px) scale(0.92)';
            setTimeout(() => {
                if (this.bubbleEl && this.bubbleEl.style.opacity === '0') {
                    this.bubbleEl.style.visibility = 'hidden';
                }
            }, 230);

            if (this.pipWindow && this.pipBubbleEl) {
                this.pipBubbleEl.style.opacity = '0.3';
            }
        }

        applyConfig() {
            if (!this.widgetEl) return;

            if (!this.config.enabled) {
                this.widgetEl.style.display = 'none';
                return;
            }

            this.widgetEl.style.display = 'flex';
            this.widgetEl.style.opacity = String(this.config.opacity || 0.95);

            const size = Math.max(36, Math.min(84, Number(this.config.size) || 56));
            if (this.avatarEl) {
                this.avatarEl.style.width = `${size}px`;
                this.avatarEl.style.height = `${size}px`;
            }

            this.updateAvatarImage();
            this.clampPosition();
        }

        clampPosition() {
            if (!this.widgetEl) return;
            const size = this.config.size || 56;
            const winW = window.innerWidth;
            const winH = window.innerHeight;

            let x = this.config.posX;
            let y = this.config.posY;

            if (x === -1 || x === undefined || x > winW - size) x = winW - size - 20;
            if (y === -1 || y === undefined || y > winH - size) y = winH - size - 140;

            x = Math.max(8, Math.min(x, winW - size - 8));
            y = Math.max(8, Math.min(y, winH - size - 8));

            this.widgetEl.style.left = `${x}px`;
            this.widgetEl.style.top = `${y}px`;
            this.currentX = x;
            this.currentY = y;
        }

        updateAvatarImage() {
            if (!this.avatarEl) return;
            const img = this.avatarEl.querySelector('.floating-pet-avatar-img');
            if (!img) return;

            const type = this.config.avatarType || 'partner';

            if (type === 'custom' && this.config.customAvatarUrl) {
                img.src = this.config.customAvatarUrl;
            } else {
                const partnerAv = typeof settings !== 'undefined' && settings.partnerAvatar ? settings.partnerAvatar : '';
                img.src = partnerAv || 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="50" fill="%23FF6B8B"/><text x="50" y="62" font-size="36" text-anchor="middle" fill="%23fff">TA</text></svg>';
            }
        }

        // 打开设置面板
        openConfigModal() {
            let modal = document.getElementById('floating-pet-modal');
            if (!modal) {
                modal = this.createConfigModalDOM();
                document.body.appendChild(modal);
            }
            this.populateConfigData(modal);
            if (!modal._eventsBound) {
                this.bindModalEvents(modal);
                modal._eventsBound = true;
            }
            if (typeof showModal === 'function') {
                showModal(modal);
            } else {
                modal.classList.add('active');
                modal.style.display = 'flex';
            }
        }

        createConfigModalDOM() {
            let modal = document.getElementById('floating-pet-modal');
            if (modal) return modal;
            modal = document.createElement('div');
            modal.id = 'floating-pet-modal';
            modal.className = 'modal custom-pet-modal';
            modal.style.zIndex = '2500';
            return modal;
        }

        populateConfigData(modal) {
            const cfg = this.config;
            const kCfg = keepAlive.config;

            // 总开关
            const enableCheck = modal.querySelector('#pet-toggle-enable');
            if (enableCheck) enableCheck.checked = !!cfg.enabled;

            // 形象来源
            this.updateAvatarTypeUI(modal, cfg.avatarType || 'partner');

            // 自定义图预览
            const prevWrap = modal.querySelector('#pet-custom-preview-wrap');
            const prevImg = modal.querySelector('#pet-custom-preview-img');
            if (cfg.customAvatarUrl) {
                if (prevWrap) prevWrap.style.display = 'block';
                if (prevImg) prevImg.src = cfg.customAvatarUrl;
            }

            // 保活选项
            const workerCheck = modal.querySelector('#pet-keepalive-worker');
            const wakeCheck = modal.querySelector('#pet-keepalive-wakelock');
            const audioCheck = modal.querySelector('#pet-keepalive-audio');

            if (workerCheck) workerCheck.checked = kCfg.workerTimerEnabled !== false;
            if (wakeCheck) wakeCheck.checked = !!kCfg.wakeLockEnabled;
            if (audioCheck) audioCheck.checked = !!kCfg.silentAudioEnabled;
        }

        updateAvatarTypeUI(modal, selectedType) {
            modal.querySelectorAll('.pet-avatar-type-btn').forEach(btn => {
                if (btn.dataset.type === selectedType) {
                    btn.style.borderColor = 'var(--accent-color)';
                    btn.style.background = 'rgba(var(--accent-color-rgb, 255,107,139), 0.12)';
                    btn.style.boxShadow = '0 0 0 1px var(--accent-color)';
                } else {
                    btn.style.borderColor = 'var(--border-color)';
                    btn.style.background = 'var(--primary-bg, #f7f7f7)';
                    btn.style.boxShadow = 'none';
                }
            });

            const customBox = modal.querySelector('#pet-custom-upload-box');
            if (customBox) customBox.style.display = selectedType === 'custom' ? 'block' : 'none';
        }

        bindModalEvents(modal) {
            let currentType = this.config.avatarType || 'partner';
            let currentCustomUrl = this.config.customAvatarUrl || '';

            const closeModal = () => {
                if (typeof hideModal === 'function') {
                    hideModal(modal);
                } else {
                    modal.classList.remove('active');
                    modal.style.display = 'none';
                }
            };

            modal.querySelector('#pet-modal-close-x')?.addEventListener('click', closeModal);
            modal.querySelector('#pet-modal-cancel')?.addEventListener('click', closeModal);
            modal.addEventListener('click', (e) => {
                if (e.target === modal) closeModal();
            });

            modal.querySelectorAll('.pet-avatar-type-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    currentType = btn.dataset.type;
                    this.updateAvatarTypeUI(modal, currentType);
                });
            });

            // 上传图片
            const uploadInput = modal.querySelector('#pet-upload-file-input');
            const uploadBtn = modal.querySelector('#pet-trigger-upload-btn');
            const prevWrap = modal.querySelector('#pet-custom-preview-wrap');
            const prevImg = modal.querySelector('#pet-custom-preview-img');

            if (uploadBtn && uploadInput) {
                uploadBtn.onclick = () => uploadInput.click();
                uploadInput.onchange = (e) => {
                    const file = e.target.files && e.target.files[0];
                    if (!file) return;
                    const reader = new FileReader();
                    reader.onload = (re) => {
                        currentCustomUrl = re.target.result;
                        if (prevWrap) prevWrap.style.display = 'block';
                        if (prevImg) prevImg.src = currentCustomUrl;
                        if (typeof showNotification === 'function') {
                            showNotification('形象已就绪', 'success');
                        }
                    };
                    reader.readAsDataURL(file);
                };
            }

            // 画中画
            modal.querySelector('#pet-pip-trigger-btn')?.addEventListener('click', () => {
                this.openPictureInPicture();
            });

            // 保存按钮
            modal.querySelector('#pet-modal-save')?.addEventListener('click', () => {
                const enabled = !!modal.querySelector('#pet-toggle-enable')?.checked;

                // 保存保活配置
                const workerTimerEnabled = !!modal.querySelector('#pet-keepalive-worker')?.checked;
                const wakeLockEnabled = !!modal.querySelector('#pet-keepalive-wakelock')?.checked;
                const silentAudioEnabled = !!modal.querySelector('#pet-keepalive-audio')?.checked;

                keepAlive.saveConfig({ workerTimerEnabled, wakeLockEnabled, silentAudioEnabled });

                // 保存桌宠配置
                this.saveConfig({
                    enabled,
                    avatarType: currentType,
                    customAvatarUrl: currentCustomUrl
                });

                closeModal();

                if (typeof showNotification === 'function') {
                    showNotification(enabled ? '桌面悬浮桌宠已开启，后台保活已就绪' : '桌宠设置已保存', 'success');
                }
            });
        }

        // 画中画模式
        async openPictureInPicture() {
            if (!('documentPictureInPicture' in window)) {
                if (typeof showNotification === 'function') {
                    showNotification('当前浏览器不支持跨桌面 Document PiP，网页内已常驻桌面悬浮桌宠', 'info', 3500);
                }
                return;
            }

            try {
                if (this.pipWindow) {
                    this.pipWindow.close();
                    this.pipWindow = null;
                }

                const pip = await window.documentPictureInPicture.requestWindow({
                    width: 220,
                    height: 220
                });
                this.pipWindow = pip;

                [...document.styleSheets].forEach((styleSheet) => {
                    try {
                        const cssRules = [...styleSheet.cssRules].map((rule) => rule.cssText).join('');
                        const style = document.createElement('style');
                        style.textContent = cssRules;
                        pip.document.head.appendChild(style);
                    } catch (e) {
                        const link = document.createElement('link');
                        if (styleSheet.href) {
                            link.rel = 'stylesheet';
                            link.type = styleSheet.type;
                            link.href = styleSheet.href;
                            pip.document.head.appendChild(link);
                        }
                    }
                });

                pip.document.body.style.cssText = 'margin:0; padding:14px; display:flex; flex-direction:column; align-items:center; justify-content:center; background:var(--secondary-bg, #FFF); font-family:sans-serif; height:100%; box-sizing:border-box; overflow:hidden;';

                const bubbleBox = document.createElement('div');
                bubbleBox.style.cssText = 'padding:8px 12px; background:var(--primary-bg, #f5f5f5); border-radius:12px; font-size:12px; line-height:1.4; color:var(--text-primary, #333); margin-bottom:12px; text-align:center; box-shadow:0 2px 8px rgba(0,0,0,0.1); border:1px solid var(--border-color, #eee); transition:opacity 0.2s; opacity:0.6;';
                bubbleBox.textContent = '静候对方消息...';
                this.pipBubbleEl = bubbleBox;

                const avatarBox = document.createElement('div');
                avatarBox.style.cssText = 'width:62px; height:62px; border-radius:50%; overflow:hidden; border:2.5px solid var(--accent-color, #FF6B8B); box-shadow:0 4px 12px rgba(0,0,0,0.15); cursor:pointer;';

                const pipImg = document.createElement('img');
                pipImg.style.cssText = 'width:100%; height:100%; object-fit:cover;';

                const currImg = this.avatarEl?.querySelector('.floating-pet-avatar-img');
                if (currImg) pipImg.src = currImg.src;

                avatarBox.appendChild(pipImg);
                avatarBox.onclick = () => {
                    this.handleAvatarClick();
                };

                pip.document.body.appendChild(bubbleBox);
                pip.document.body.appendChild(avatarBox);

                pip.addEventListener('pagehide', () => {
                    this.pipWindow = null;
                    this.pipBubbleEl = null;
                });

                if (typeof showNotification === 'function') {
                    showNotification('跨桌面桌宠画中画已开启', 'success');
                }
            } catch (err) {
                console.warn('[FloatingPet] PiP 开启失败:', err);
                if (typeof showNotification === 'function') {
                    showNotification('画中画开启失败: ' + err.message, 'error');
                }
            }
        }
    }

    const pet = new FloatingPetWidget();
    global.FloatingPetWidget = pet;
    global.openFloatingPetModal = () => pet.openConfigModal();
    global.openFloatingCompanionModal = () => pet.openConfigModal();

})(typeof window !== 'undefined' ? window : this);
