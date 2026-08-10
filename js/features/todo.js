/**
 * milk · 待办清单模块
 * 功能：添加/删除、勾选完成、分类、优先级、截止日期、localforage 持久化
 */
(function () {
    const STORAGE_KEY = 'milk_todos';
    const PRIORITY_LABEL = { high: '🔴 高', medium: '🟡 中', low: '🟢 低' };
    const CATEGORY_ICON  = { '学习': '📚', '生活': '🏠', '工作': '💼', '娱乐': '🎮', '其他': '📌' };

    let todos = [];       // { id, text, done, priority, category, dueDate, createdAt }
    let currentFilter = 'all';

    /* ── 持久化 ── */
    async function loadTodos() {
        try {
            const saved = await localforage.getItem(STORAGE_KEY);
            todos = Array.isArray(saved) ? saved : [];
        } catch (e) { todos = []; }
    }
    function saveTodos() {
        localforage.setItem(STORAGE_KEY, todos).catch(() => {});
    }

    /* ── 过滤 ── */
    function filterTodos() {
        const today = new Date(); today.setHours(0,0,0,0);
        return todos.filter(t => {
            if (currentFilter === 'todo')   return !t.done;
            if (currentFilter === 'done')   return  t.done;
            if (currentFilter === 'high')   return t.priority === 'high';
            if (currentFilter === 'medium') return t.priority === 'medium';
            if (currentFilter === 'low')    return t.priority === 'low';
            return true;
        }).sort((a, b) => {
            if (a.done !== b.done) return a.done ? 1 : -1;
            const pOrder = { high: 0, medium: 1, low: 2 };
            return (pOrder[a.priority] || 1) - (pOrder[b.priority] || 1);
        });
    }

    /* ── 渲染 ── */
    function render() {
        const list = document.getElementById('todo-list');
        const statsText = document.getElementById('todo-stats-text');
        if (!list) return;

        const total = todos.length;
        const done  = todos.filter(t => t.done).length;
        if (statsText) statsText.textContent = `共 ${total} 项 · 已完成 ${done} 项`;

        const visible = filterTodos();
        if (visible.length === 0) {
            list.innerHTML = `<div class="todo-empty"><i class="fas fa-clipboard-list" style="font-size:28px;opacity:.3;display:block;margin-bottom:8px;"></i>暂无待办～</div>`;
            return;
        }

        const today = new Date(); today.setHours(0,0,0,0);

        list.innerHTML = visible.map(t => {
            const tags = [];
            if (t.priority) tags.push(`<span class="todo-tag">${PRIORITY_LABEL[t.priority] || t.priority}</span>`);
            if (t.category) tags.push(`<span class="todo-tag">${CATEGORY_ICON[t.category] || ''}${t.category}</span>`);
            if (t.dueDate) {
                const due = new Date(t.dueDate); due.setHours(0,0,0,0);
                const diff = Math.round((due - today) / 86400000);
                let dueTxt = t.dueDate;
                let isOverdue = false;
                if (!t.done && diff < 0)  { dueTxt = `逾期 ${-diff} 天`; isOverdue = true; }
                else if (!t.done && diff === 0) dueTxt = '今天截止';
                else if (!t.done && diff === 1) dueTxt = '明天截止';
                tags.push(`<span class="todo-tag${isOverdue ? ' overdue' : ''}">📅 ${dueTxt}</span>`);
            }
            return `<div class="todo-item${t.done ? ' done-item' : ''}" data-id="${t.id}">
                <input type="checkbox" ${t.done ? 'checked' : ''} data-toggle="${t.id}">
                <div class="todo-item-body">
                    <div class="todo-item-text">${escapeHtml(t.text)}</div>
                    ${tags.length ? `<div class="todo-item-meta">${tags.join('')}</div>` : ''}
                </div>
                <button class="todo-delete-btn" data-delete="${t.id}" title="删除"><i class="fas fa-trash-alt"></i></button>
            </div>`;
        }).join('');
    }

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    }

    /* ── 操作 ── */
    function addTodo() {
        const textEl = document.getElementById('todo-input-text');
        const priEl  = document.getElementById('todo-input-priority');
        const catEl  = document.getElementById('todo-input-category');
        const dateEl = document.getElementById('todo-input-date');
        const text = (textEl && textEl.value.trim()) || '';
        if (!text) { textEl && textEl.focus(); return; }

        todos.unshift({
            id: Date.now(),
            text,
            done: false,
            priority: (priEl && priEl.value) || 'medium',
            category: (catEl && catEl.value) || '',
            dueDate: (dateEl && dateEl.value) || '',
            createdAt: new Date().toISOString()
        });
        if (textEl) textEl.value = '';
        saveTodos();
        render();
    }

    function toggleDone(id) {
        const t = todos.find(x => x.id === Number(id));
        if (t) { t.done = !t.done; saveTodos(); render(); }
    }

    function deleteTodo(id) {
        todos = todos.filter(x => x.id !== Number(id));
        saveTodos();
        render();
    }

    function clearDone() {
        todos = todos.filter(t => !t.done);
        saveTodos();
        render();
    }

    /* ── 事件委托 ── */
    function bindListEvents() {
        const list = document.getElementById('todo-list');
        if (!list) return;
        list.addEventListener('change', e => {
            const id = e.target.dataset.toggle;
            if (id) toggleDone(id);
        });
        list.addEventListener('click', e => {
            const delBtn = e.target.closest('[data-delete]');
            if (delBtn) deleteTodo(delBtn.dataset.delete);
        });
    }

    function bindModalEvents() {
        const addBtn   = document.getElementById('todo-add-btn');
        const inputTxt = document.getElementById('todo-input-text');
        const closeBtn = document.getElementById('close-todo-modal');
        const clearBtn = document.getElementById('todo-clear-done');

        if (addBtn)   addBtn.addEventListener('click', addTodo);
        if (inputTxt) inputTxt.addEventListener('keydown', e => { if (e.key === 'Enter') addTodo(); });
        if (closeBtn) closeBtn.addEventListener('click', () => {
            const modal = document.getElementById('todo-modal');
            if (modal && typeof hideModal === 'function') hideModal(modal);
        });
        if (clearBtn) clearBtn.addEventListener('click', clearDone);

        // filter buttons
        document.querySelectorAll('.todo-filter-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.todo-filter-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                currentFilter = btn.dataset.filter;
                render();
            });
        });

        bindListEvents();
    }

    /* ── 公开入口 ── */
    window._openTodoModal = async function () {
        await loadTodos();
        const modal = document.getElementById('todo-modal');
        if (!modal) return;
        render();
        if (typeof showModal === 'function') showModal(modal);
    };

    // 初始化事件（DOM ready）
    function init() {
        bindModalEvents();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
