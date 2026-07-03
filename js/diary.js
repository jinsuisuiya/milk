// ════════════════════════════════════════════
// 日记功能 (Diary Feature)
// ════════════════════════════════════════════

(function() {
    'use strict';

    // ── 状态 ──
    let diaryEntries  = [];         // [{ id, date, content, reply, repliedAt }]
    let currentEntry  = null;       // 当前查看的日记对象
    let draftCards    = [];         // 已选字卡文本列表
    let deckPool      = [];         // 当前展示的一批字卡

    const DECK_SIZE   = 20;        // 每次展示多少张字卡

    // ── 存取 ──
    async function loadDiary() {
        const saved = await localforage.getItem(getStorageKey('diaryEntries'));
        if (Array.isArray(saved)) diaryEntries = saved;
    }
    function saveDiary() {
        localforage.setItem(getStorageKey('diaryEntries'), diaryEntries);
    }

    // ── 工具 ──
    function escHtml(s) {
        return String(s)
            .replace(/&/g,'&amp;').replace(/</g,'&lt;')
            .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }
    function fmtDate(ts) {
        return new Date(ts).toLocaleDateString('zh-CN', {
            year:'numeric', month:'long', day:'numeric',
            weekday:'short', hour:'2-digit', minute:'2-digit'
        });
    }

    // ── 视图切换 ──
    function showView(name) {
        const views = ['list','write','read'];
        views.forEach(v => {
            const el = document.getElementById(`diary-view-${v}`);
            if (el) el.style.display = (v === name) ? 'flex' : 'none';
        });
        const backBtn   = document.getElementById('diary-back-btn');
        const titleEl   = document.getElementById('diary-modal-title');
        const titles    = { list:'我的日记', write:'写日记', read:'日记详情' };
        if (backBtn)  backBtn.style.display   = name === 'list' ? 'none' : 'flex';
        if (titleEl)  titleEl.textContent      = titles[name] || '我的日记';
    }

    // ── 列表 ──
    function renderList() {
        const container = document.getElementById('diary-list-container');
        const hint      = document.getElementById('diary-empty-hint');
        if (!container) return;
        // remove old cards
        Array.from(container.children).forEach(c => {
            if (c.id !== 'diary-empty-hint') c.remove();
        });
        if (diaryEntries.length === 0) {
            if (hint) hint.style.display = 'block';
            return;
        }
        if (hint) hint.style.display = 'none';
        const sorted = [...diaryEntries].sort((a,b) => b.date - a.date);
        sorted.forEach(entry => {
            const card = document.createElement('div');
            card.className = 'diary-list-card';
            const preview = entry.content.length > 55
                ? entry.content.slice(0,55) + '…'
                : entry.content;
            const hasReply = !!entry.reply;
            card.innerHTML = `
                <div class="diary-card-meta">
                    <span class="diary-card-date">${fmtDate(entry.date)}</span>
                    ${hasReply
                        ? '<span class="diary-card-badge replied"><i class="fas fa-reply"></i> 已回复</span>'
                        : '<span class="diary-card-badge pending">待回复</span>'}
                </div>
                <div class="diary-card-preview">${escHtml(preview)}</div>
                <button class="diary-card-delete" onclick="event.stopPropagation();window.diaryDelete('${entry.id}')" title="删除"><i class="fas fa-trash-alt"></i></button>
            `;
            card.addEventListener('click', () => window.diaryOpenRead(entry.id));
            container.appendChild(card);
        });
    }

    // ── 写日记 ──
    window.diaryOpenWrite = function() {
        const dateEl    = document.getElementById('diary-write-date');
        const contentEl = document.getElementById('diary-write-content');
        if (dateEl)    dateEl.textContent  = fmtDate(Date.now());
        if (contentEl) contentEl.value     = '';
        showView('write');
        setTimeout(() => contentEl && contentEl.focus(), 100);
    };

    window.diarySave = function() {
        const contentEl = document.getElementById('diary-write-content');
        const text = contentEl ? contentEl.value.trim() : '';
        if (!text) { if (contentEl) contentEl.focus(); return; }
        const entry = {
            id:      Date.now().toString(36) + Math.random().toString(36).slice(2,5),
            date:    Date.now(),
            content: text,
            reply:   null,
            repliedAt: null
        };
        diaryEntries.push(entry);
        saveDiary();
        renderList();
        showView('list');
        if (typeof showNotification === 'function')
            showNotification('日记已保存 ✍', 'success', 2000);
    };

    // ── 阅读 + 字卡 ──
    window.diaryOpenRead = function(id) {
        const entry = diaryEntries.find(e => e.id === id);
        if (!entry) return;
        currentEntry = entry;
        draftCards   = [];

        document.getElementById('diary-read-date').textContent    = fmtDate(entry.date);
        document.getElementById('diary-read-content').textContent  = entry.content;

        const replySection = document.getElementById('diary-reply-section');
        const cardSection  = document.getElementById('diary-card-section');
        const existingReply= document.getElementById('diary-existing-reply');

        if (entry.reply) {
            replySection.style.display  = 'block';
            existingReply.textContent   = entry.reply;
            // 已有回复，仍允许再回复（更新）
        } else {
            replySection.style.display  = 'none';
        }
        cardSection.style.display = 'block';

        renderDraftArea();
        drawCardDeck();
        showView('read');
    };

    // 从 customReplies 抽取一批字卡
    function drawCardDeck() {
        const pool = window._customReplies || [];
        if (pool.length === 0) {
            // 备用：内置词组
            deckPool = [
                '好棒','真的吗','我懂','没事的','加油','辛苦了',
                '嗯嗯','抱抱','开心','心疼','想你','爱你',
                '没关系','慢慢来','我在','放松一下','吃饭了吗','注意休息',
                '哈哈','嘻嘻','么么哒','晚安'
            ];
        } else {
            // 打乱并取前 DECK_SIZE 条
            const shuffled = [...pool].sort(() => Math.random() - 0.5);
            deckPool = shuffled.slice(0, DECK_SIZE);
        }
        renderCardDeck();
    }

    function renderCardDeck() {
        const deck = document.getElementById('diary-card-deck');
        if (!deck) return;
        deck.innerHTML = '';
        deckPool.forEach((word, i) => {
            const chip = document.createElement('button');
            chip.className = 'diary-word-card';
            chip.textContent = word;
            chip.addEventListener('click', () => window.diaryPickCard(word, chip));
            deck.appendChild(chip);
        });
    }

    function renderDraftArea() {
        const draftText = document.getElementById('diary-draft-text');
        if (!draftText) return;
        if (draftCards.length === 0) {
            draftText.style.color = 'var(--text-secondary)';
            draftText.textContent = '点击字卡选词，点此处撤销最后一个';
        } else {
            draftText.style.color = 'var(--text-primary)';
            draftText.textContent = draftCards.join('');
        }
    }

    window.diaryPickCard = function(word, chipEl) {
        draftCards.push(word);
        renderDraftArea();
        // 短暂高亮
        chipEl.classList.add('picked');
        setTimeout(() => chipEl.classList.remove('picked'), 300);
    };

    window.diaryUndoLastCard = function() {
        if (draftCards.length === 0) return;
        draftCards.pop();
        renderDraftArea();
    };

    window.diaryShuffleCards = function() {
        draftCards = [];
        renderDraftArea();
        drawCardDeck();
    };

    window.diarySendReply = function() {
        if (!currentEntry) return;
        const text = draftCards.join('').trim();
        if (!text) {
            if (typeof showNotification === 'function')
                showNotification('请先选几张字卡组成回复~', 'info', 2000);
            return;
        }
        currentEntry.reply      = text;
        currentEntry.repliedAt  = Date.now();
        saveDiary();

        // 更新已有回复区
        const replySection  = document.getElementById('diary-reply-section');
        const existingReply = document.getElementById('diary-existing-reply');
        replySection.style.display  = 'block';
        existingReply.textContent   = text;

        draftCards = [];
        renderDraftArea();

        if (typeof showNotification === 'function')
            showNotification('回复已发送 💌', 'success', 2000);
    };

    // ── 删除 ──
    window.diaryDelete = function(id) {
        diaryEntries = diaryEntries.filter(e => e.id !== id);
        saveDiary();
        renderList();
        if (typeof showNotification === 'function')
            showNotification('日记已删除', 'info', 1800);
    };

    // ── 返回 ──
    window.diaryGoBack = function() {
        const writeView = document.getElementById('diary-view-write');
        const readView  = document.getElementById('diary-view-read');
        if (writeView && writeView.style.display !== 'none') { showView('list'); return; }
        if (readView  && readView.style.display  !== 'none') { renderList(); showView('list'); return; }
        showView('list');
    };

    // ── 入口（由 listeners.js 调用） ──
    window.openDiaryModal = async function() {
        await loadDiary();
        renderList();
        showView('list');
        const modal = document.getElementById('diary-modal');
        if (modal && typeof showModal === 'function') showModal(modal);
        else if (modal) modal.classList.add('active');
    };

})();
