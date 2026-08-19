/**
 * GitHub 云端备份与同步模块 (GitHub Cloud Backup & Restore Module)
 * 允许用户通过 GitHub Token、用户名、仓库名将传讯数据安全备份至 GitHub 私有/公开仓库，并支持一键恢复。
 */

(function() {
    'use strict';

    const CONFIG_KEY = 'chatapp_github_backup_config';

    // 默认配置
    const DEFAULT_CONFIG = {
        owner: '',
        repo: '',
        token: '',
        path: 'backup/chatapp-backup.json',
        branch: 'main',
        lastBackupTime: null,
        lastBackupSha: null,
        lastBackupUrl: null
    };

    const GitHubBackup = {
        getConfig() {
            try {
                const saved = localStorage.getItem(CONFIG_KEY);
                if (!saved) return { ...DEFAULT_CONFIG };
                const parsed = JSON.parse(saved);
                return { ...DEFAULT_CONFIG, ...parsed };
            } catch (e) {
                console.error('[GitHubBackup] 读取配置失败:', e);
                return { ...DEFAULT_CONFIG };
            }
        },

        saveConfig(cfg) {
            try {
                const current = this.getConfig();
                const merged = { ...current, ...cfg };
                localStorage.setItem(CONFIG_KEY, JSON.stringify(merged));
                return true;
            } catch (e) {
                console.error('[GitHubBackup] 保存配置失败:', e);
                return false;
            }
        },

        // UTF-8 字符串转 Base64（支持中文与大文本）
        utf8ToBase64(str) {
            const bytes = new TextEncoder().encode(str);
            let binary = '';
            const len = bytes.byteLength;
            const chunk = 0x8000;
            for (let i = 0; i < len; i += chunk) {
                binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + chunk, len)));
            }
            return btoa(binary);
        },

        // Base64 转 UTF-8 字符串
        base64ToUtf8(b64) {
            const clean = b64.replace(/\s/g, '');
            const binary = atob(clean);
            const len = binary.length;
            const bytes = new Uint8Array(len);
            for (let i = 0; i < len; i++) {
                bytes[i] = binary.charCodeAt(i);
            }
            return new TextDecoder('utf-8').decode(bytes);
        },

        // 测试 GitHub 连通性与权限
        async testConnection(cfgInput) {
            const cfg = cfgInput || this.getConfig();
            const token = (cfg.token || '').trim();
            const owner = (cfg.owner || '').trim();
            const repo = (cfg.repo || '').trim();

            if (!owner) throw new Error('请输入 GitHub 用户名');
            if (!repo) throw new Error('请输入 GitHub 仓库名');
            if (!token) throw new Error('请输入 GitHub Personal Access Token (PAT)');

            const headers = {
                'Authorization': `token ${token}`,
                'Accept': 'application/vnd.github.v3+json',
                'User-Agent': 'ChatApp-Backup'
            };

            // 1. 验证用户与仓库
            const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
            let res;
            try {
                res = await fetch(url, { headers });
            } catch (err) {
                throw new Error('网络连接失败，请检查网络或代理设置');
            }

            if (res.status === 401) {
                throw new Error('GitHub Token 无效或已过期 (401 Unauthorized)');
            } else if (res.status === 404) {
                throw new Error(`未找到仓库 "${owner}/${repo}"。若是私有仓库，请确保 Token 勾选了 "repo" 权限范围。`);
            } else if (res.status === 403) {
                const rateMsg = res.headers.get('x-ratelimit-remaining') === '0' ? 'API 速率限制已耗尽' : '权限不足';
                throw new Error(`访问被拒绝 (403): ${rateMsg}`);
            } else if (!res.ok) {
                const errorData = await res.json().catch(() => ({}));
                throw new Error(`GitHub API 错误 (${res.status}): ${errorData.message || res.statusText}`);
            }

            const repoData = await res.json();
            return {
                ok: true,
                repoName: repoData.full_name,
                isPrivate: repoData.private,
                defaultBranch: repoData.default_branch || 'main',
                permissions: repoData.permissions || {}
            };
        },

        // 获取远端备份文件的元数据与 sha
        async getRemoteFileInfo(cfgInput) {
            const cfg = cfgInput || this.getConfig();
            const token = (cfg.token || '').trim();
            const owner = (cfg.owner || '').trim();
            const repo = (cfg.repo || '').trim();
            const path = (cfg.path || 'backup/chatapp-backup.json').trim();
            const branch = (cfg.branch || 'main').trim();

            const headers = {
                'Authorization': `token ${token}`,
                'Accept': 'application/vnd.github.v3+json',
                'User-Agent': 'ChatApp-Backup'
            };

            const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodeURI(path)}?ref=${encodeURIComponent(branch)}`;
            const res = await fetch(url, { headers });

            if (res.status === 404) {
                return { exists: false };
            }
            if (!res.ok) {
                if (res.status === 401) throw new Error('Token 无效或已过期');
                throw new Error(`获取文件信息失败 (${res.status})`);
            }

            const data = await res.json();
            return {
                exists: true,
                sha: data.sha,
                size: data.size,
                downloadUrl: data.download_url,
                htmlUrl: data.html_url,
                content: data.content,
                encoding: data.encoding
            };
        },

        // 上传备份至 GitHub
        async uploadBackup(options = {}) {
            const cfg = this.getConfig();
            const token = (cfg.token || '').trim();
            const owner = (cfg.owner || '').trim();
            const repo = (cfg.repo || '').trim();
            const path = (cfg.path || 'backup/chatapp-backup.json').trim();
            const branch = (cfg.branch || 'main').trim();

            if (!owner || !repo || !token) {
                throw new Error('请先在设置中填写 GitHub 用户名、仓库名和 Token');
            }

            // 1. 构建备份数据包
            if (typeof ChatBackup === 'undefined' || !ChatBackup.buildBackupPayload || !ChatBackup.serializeBackupV4) {
                throw new Error('备份引擎未完全就绪，请刷新页面后重试');
            }

            const payload = await ChatBackup.buildBackupPayload({
                inclMsgs: options.inclMsgs !== false,
                inclSet: options.inclSet !== false,
                inclCustom: options.inclCustom !== false,
                inclAnn: options.inclAnn !== false,
                inclThemes: options.inclThemes !== false,
                inclDg: options.inclDg !== false,
                inclStickers: options.inclStickers === true
            });

            // 补充 GitHub 备份元信息
            payload.githubBackupMeta = {
                syncedAt: new Date().toISOString(),
                sourceApp: 'ChatApp',
                device: navigator.userAgent
            };

            const jsonStr = ChatBackup.serializeBackupV4(payload);
            const base64Content = this.utf8ToBase64(jsonStr);

            // 2. 检查远端文件是否已有 sha
            const remoteInfo = await this.getRemoteFileInfo(cfg);
            const sha = remoteInfo.exists ? remoteInfo.sha : undefined;

            // 3. 提交到 GitHub
            const commitMessage = options.commitMessage || `Data Backup: ${new Date().toLocaleString()} (传讯数据备份)`;
            const body = {
                message: commitMessage,
                content: base64Content,
                branch: branch
            };
            if (sha) {
                body.sha = sha;
            }

            const putUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodeURI(path)}`;
            const putRes = await fetch(putUrl, {
                method: 'PUT',
                headers: {
                    'Authorization': `token ${token}`,
                    'Accept': 'application/vnd.github.v3+json',
                    'Content-Type': 'application/json',
                    'User-Agent': 'ChatApp-Backup'
                },
                body: JSON.stringify(body)
            });

            if (!putRes.ok) {
                const errData = await putRes.json().catch(() => ({}));
                if (putRes.status === 409) {
                    throw new Error('提交冲突 (409 Conflict)，请重试');
                }
                throw new Error(`上传失败 (${putRes.status}): ${errData.message || putRes.statusText}`);
            }

            const resData = await putRes.json();
            const newSha = resData.content?.sha || resData.commit?.sha;
            const commitUrl = resData.commit?.html_url || `https://github.com/${owner}/${repo}/blob/${branch}/${path}`;

            // 4. 更新本地同步状态
            const nowTime = new Date().toISOString();
            this.saveConfig({
                lastBackupTime: nowTime,
                lastBackupSha: newSha,
                lastBackupUrl: commitUrl
            });

            return {
                ok: true,
                time: nowTime,
                sha: newSha,
                url: commitUrl,
                size: jsonStr.length
            };
        },

        // 从 GitHub 拉取备份文件
        async fetchBackup() {
            const cfg = this.getConfig();
            const token = (cfg.token || '').trim();
            const owner = (cfg.owner || '').trim();
            const repo = (cfg.repo || '').trim();
            const path = (cfg.path || 'backup/chatapp-backup.json').trim();
            const branch = (cfg.branch || 'main').trim();

            if (!owner || !repo || !token) {
                throw new Error('请先在设置中填写 GitHub 用户名、仓库名和 Token');
            }

            const fileInfo = await this.getRemoteFileInfo(cfg);
            if (!fileInfo.exists) {
                throw new Error(`仓库中未找到备份文件: ${path} (分支: ${branch})`);
            }

            let jsonStr = '';
            if (fileInfo.content && fileInfo.encoding === 'base64') {
                jsonStr = this.base64ToUtf8(fileInfo.content);
            } else if (fileInfo.downloadUrl) {
                const rawRes = await fetch(fileInfo.downloadUrl, {
                    headers: { 'Authorization': `token ${token}` }
                });
                if (!rawRes.ok) throw new Error('下载备份文件内容失败');
                jsonStr = await rawRes.text();
            } else {
                throw new Error('无法解析远端文件内容');
            }

            let backupData;
            try {
                if (jsonStr.charCodeAt(0) === 0xFEFF) jsonStr = jsonStr.slice(1);
                backupData = JSON.parse(jsonStr);
            } catch (e) {
                throw new Error('远端备份文件损坏或不是有效的 JSON 格式');
            }

            return {
                fileInfo,
                backupData
            };
        },

        // 恢复数据
        async restoreBackup(backupData, options = {}) {
            if (typeof ChatBackup === 'undefined' || !ChatBackup.applyBackupToStorage) {
                throw new Error('备份引擎未就绪');
            }
            await ChatBackup.applyBackupToStorage(backupData, options);
            return true;
        },

        // 模态框 UI 管理
        openModal(initialTab = 'sync') {
            let modal = document.getElementById('github-backup-modal');
            if (!modal) {
                modal = this.createModalElement();
                document.body.appendChild(modal);
            }
            
            // 确保内部结构已构建
            this.ensureModalStructure(modal);

            // 加载最新配置到界面
            this.updateModalData(modal);

            // 切换到指定标签页
            this.switchTab(modal, initialTab);

            // 关闭可能重叠打开的其它弹窗
            ['settings-modal', 'advanced-modal', 'data-modal', 'chat-modal', 'appearance-modal'].forEach(id => {
                const other = document.getElementById(id);
                if (other) {
                    if (typeof hideModal === 'function') {
                        try { hideModal(other); } catch (e) {}
                    }
                    other.style.display = 'none';
                }
            });

            modal.style.display = 'flex';
            document.body.style.overflow = 'hidden';
        },

        closeModal() {
            const modal = document.getElementById('github-backup-modal');
            if (modal) {
                modal.style.display = 'none';
                document.body.style.overflow = '';
            }
        },

        createModalElement() {
            const modal = document.createElement('div');
            modal.id = 'github-backup-modal';
            modal.className = 'modal';
            return modal;
        },

        ensureModalStructure(modal) {
            if (modal.querySelector('.github-backup-dialog')) return;

            modal.innerHTML = `
                <div class="github-backup-dialog" style="background:var(--secondary-bg);border-radius:22px;width:100%;max-width:480px;max-height:88vh;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,0.35);border:1px solid var(--border-color);overflow:hidden;opacity:1;color:var(--text-primary);">
                    
                    <!-- 顶部标题栏 -->
                    <div style="display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid var(--border-color);background:var(--secondary-bg);flex-shrink:0;">
                        <div style="display:flex;align-items:center;gap:10px;">
                            <div style="width:36px;height:36px;border-radius:10px;background:linear-gradient(135deg,#24292e,#1a1e22);color:#fff;display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0;">
                                <i class="fab fa-github"></i>
                            </div>
                            <div>
                                <div style="font-size:15px;font-weight:700;color:var(--text-primary);line-height:1.2;">GitHub 云端备份</div>
                                <div style="font-size:11px;color:var(--text-secondary);margin-top:2px;">将聊天记录与个性化设置托管至 GitHub 仓库</div>
                            </div>
                        </div>
                        <button id="gh-modal-close" type="button" style="width:32px;height:32px;border-radius:8px;border:none;background:rgba(var(--accent-color-rgb),0.1);color:var(--accent-color);font-size:15px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:0.2s;flex-shrink:0;">
                            <i class="fas fa-times"></i>
                        </button>
                    </div>

                    <!-- 标签导航 -->
                    <div style="display:flex;padding:4px 16px 0;background:var(--secondary-bg);border-bottom:1px solid var(--border-color);gap:8px;flex-shrink:0;">
                        <button id="gh-tab-btn-sync" class="gh-tab-btn" data-tab="sync" type="button" style="flex:1;padding:10px 4px;border:none;border-bottom:2.5px solid var(--accent-color);background:none;color:var(--accent-color);font-size:13px;font-weight:600;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:6px;">
                            <i class="fas fa-cloud-arrow-up"></i><span>备份与恢复</span>
                        </button>
                        <button id="gh-tab-btn-settings" class="gh-tab-btn" data-tab="settings" type="button" style="flex:1;padding:10px 4px;border:none;border-bottom:2.5px solid transparent;background:none;color:var(--text-secondary);font-size:13px;font-weight:600;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:6px;">
                            <i class="fas fa-key"></i><span>授权与仓库设置</span>
                        </button>
                    </div>

                    <!-- 主内容区 -->
                    <div style="flex:1;overflow-y:auto;padding:16px 20px;display:flex;flex-direction:column;gap:14px;background:var(--secondary-bg);">
                        
                        <!-- Panel 1: 备份与恢复 -->
                        <div id="gh-panel-sync" style="display:flex;flex-direction:column;gap:14px;">
                            
                            <!-- 未配置提示卡片 -->
                            <div id="gh-unconfigured-card" style="display:none;background:var(--primary-bg);border-radius:16px;border:1px dashed var(--border-color);padding:24px 20px;text-align:center;">
                                <div style="width:48px;height:48px;border-radius:14px;background:rgba(var(--accent-color-rgb),0.12);color:var(--accent-color);display:flex;align-items:center;justify-content:center;font-size:22px;margin:0 auto 12px;">
                                    <i class="fas fa-link-slash"></i>
                                </div>
                                <div style="font-size:14px;font-weight:700;color:var(--text-primary);margin-bottom:6px;">尚未配置 GitHub 仓库</div>
                                <div style="font-size:12px;color:var(--text-secondary);line-height:1.6;margin-bottom:16px;">
                                    需先配置 GitHub 用户名、仓库名与 Personal Access Token
                                </div>
                                <button id="gh-goto-settings-btn" type="button" style="padding:9px 20px;border:none;border-radius:12px;background:var(--accent-color);color:#fff;font-size:13px;font-weight:600;cursor:pointer;display:inline-flex;align-items:center;gap:6px;">
                                    <i class="fas fa-arrow-right"></i>去配置 GitHub 授权
                                </button>
                            </div>

                            <!-- 已配置仓库信息卡片 -->
                            <div id="gh-configured-card" style="display:none;background:var(--primary-bg);border:1px solid var(--border-color);border-radius:16px;padding:14px 16px;">
                                <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
                                    <span style="font-size:11px;font-weight:700;color:var(--text-secondary);letter-spacing:0.6px;text-transform:uppercase;">
                                        <i class="fas fa-code-branch" style="margin-right:4px;"></i>目标仓库
                                    </span>
                                    <span id="gh-status-badge" style="font-size:11px;font-weight:600;padding:2px 8px;border-radius:20px;background:rgba(59,200,164,0.15);color:#20A882;display:flex;align-items:center;gap:4px;">
                                        <span style="width:6px;height:6px;border-radius:50%;background:#20A882;"></span>已就绪
                                    </span>
                                </div>
                                <div id="gh-display-repo" style="font-size:14px;font-weight:700;color:var(--text-primary);font-family:monospace;word-break:break-all;margin-bottom:6px;">
                                    -
                                </div>
                                <div style="font-size:11.5px;color:var(--text-secondary);display:flex;flex-direction:column;gap:3px;">
                                    <div><i class="far fa-file-code" style="width:14px;opacity:0.7"></i> 路径: <code id="gh-display-path" style="color:var(--text-primary)">backup/chatapp-backup.json</code> (<span id="gh-display-branch">main</span>)</div>
                                    <div><i class="far fa-clock" style="width:14px;opacity:0.7"></i> 上次备份: <span id="gh-last-time" style="color:var(--text-primary)">暂无记录</span></div>
                                </div>
                            </div>

                            <!-- 备份内容选项 -->
                            <div id="gh-backup-options-box" style="background:var(--primary-bg);border:1px solid var(--border-color);border-radius:16px;padding:12px 14px;">
                                <div style="font-size:12px;font-weight:700;color:var(--text-primary);margin-bottom:8px;display:flex;align-items:center;gap:6px;">
                                    <i class="fas fa-sliders-h" style="color:var(--accent-color);"></i>备份内容勾选
                                </div>
                                <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:12px;">
                                    <label style="display:flex;align-items:center;gap:6px;cursor:pointer;color:var(--text-primary);">
                                        <input type="checkbox" id="gh-opt-msgs" checked style="accent-color:var(--accent-color)"> 聊天记录
                                    </label>
                                    <label style="display:flex;align-items:center;gap:6px;cursor:pointer;color:var(--text-primary);">
                                        <input type="checkbox" id="gh-opt-set" checked style="accent-color:var(--accent-color)"> 外观与设置
                                    </label>
                                    <label style="display:flex;align-items:center;gap:6px;cursor:pointer;color:var(--text-primary);">
                                        <input type="checkbox" id="gh-opt-custom" checked style="accent-color:var(--accent-color)"> 字卡与回复库
                                    </label>
                                    <label style="display:flex;align-items:center;gap:6px;cursor:pointer;color:var(--text-primary);">
                                        <input type="checkbox" id="gh-opt-ann" checked style="accent-color:var(--accent-color)"> 纪念日与倒数
                                    </label>
                                    <label style="display:flex;align-items:center;gap:6px;cursor:pointer;color:var(--text-primary);">
                                        <input type="checkbox" id="gh-opt-themes" checked style="accent-color:var(--accent-color)"> 自定义主题
                                    </label>
                                    <label style="display:flex;align-items:center;gap:6px;cursor:pointer;color:var(--text-primary);">
                                        <input type="checkbox" id="gh-opt-dg" checked style="accent-color:var(--accent-color)"> 今日早报公告
                                    </label>
                                </div>
                            </div>

                            <!-- 备份与恢复按钮 -->
                            <div style="display:flex;flex-direction:column;gap:10px;">
                                <button id="gh-upload-btn" type="button" style="width:100%;padding:13px;border:none;border-radius:14px;background:linear-gradient(135deg,#24292e,#1a1e22);color:#fff;font-size:14px;font-weight:600;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px;box-shadow:0 4px 14px rgba(0,0,0,0.15);transition:transform 0.15s;">
                                    <i class="fas fa-cloud-arrow-up"></i><span>立即备份至 GitHub</span>
                                </button>

                                <button id="gh-restore-btn" type="button" style="width:100%;padding:12px;border:1.5px solid var(--border-color);border-radius:14px;background:var(--primary-bg);color:var(--text-primary);font-size:13.5px;font-weight:600;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px;transition:background 0.15s;">
                                    <i class="fas fa-cloud-arrow-down" style="color:var(--accent-color)"></i><span>从 GitHub 恢复数据</span>
                                </button>
                            </div>

                            <!-- 操作状态提示 -->
                            <div id="gh-action-status" style="display:none;padding:10px 12px;border-radius:10px;font-size:12px;text-align:center;line-height:1.5;"></div>
                        </div>

                        <!-- Panel 2: 授权与仓库设置 -->
                        <div id="gh-panel-settings" style="display:none;flex-direction:column;gap:12px;">
                            <div>
                                <label style="display:block;font-size:12px;font-weight:700;color:var(--text-primary);margin-bottom:6px;">
                                    GitHub 用户名 / 组织名 <span style="color:#e05050">*</span>
                                </label>
                                <input id="gh-input-owner" type="text" placeholder="例如: your-username"
                                    style="width:100%;padding:10px 12px;border:1.5px solid var(--border-color);border-radius:12px;background:var(--primary-bg);color:var(--text-primary);font-size:13px;outline:none;box-sizing:border-box;">
                            </div>

                            <div>
                                <label style="display:block;font-size:12px;font-weight:700;color:var(--text-primary);margin-bottom:6px;">
                                    GitHub 仓库名 <span style="color:#e05050">*</span>
                                </label>
                                <input id="gh-input-repo" type="text" placeholder="例如: my-chatapp-backup"
                                    style="width:100%;padding:10px 12px;border:1.5px solid var(--border-color);border-radius:12px;background:var(--primary-bg);color:var(--text-primary);font-size:13px;outline:none;box-sizing:border-box;">
                                <div style="font-size:11px;color:var(--text-secondary);margin-top:4px;">建议在 GitHub 创建 Private（私有）仓库以保护个人隐私</div>
                            </div>

                            <div>
                                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
                                    <label style="font-size:12px;font-weight:700;color:var(--text-primary);">
                                        GitHub Personal Access Token (PAT) <span style="color:#e05050">*</span>
                                    </label>
                                    <a href="https://github.com/settings/tokens/new?scopes=repo&description=ChatApp%20Backup" target="_blank" rel="noopener noreferrer" style="font-size:11px;color:var(--accent-color);text-decoration:none;display:flex;align-items:center;gap:3px;">
                                        <i class="fas fa-external-link-alt"></i>生成 Token
                                    </a>
                                </div>
                                <div style="position:relative;">
                                    <input id="gh-input-token" type="password" placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
                                        style="width:100%;padding:10px 38px 10px 12px;border:1.5px solid var(--border-color);border-radius:12px;background:var(--primary-bg);color:var(--text-primary);font-size:13px;outline:none;box-sizing:border-box;font-family:monospace;">
                                    <button id="gh-toggle-token" type="button" style="position:absolute;right:8px;top:50%;transform:translateY(-50%);background:none;border:none;color:var(--text-secondary);cursor:pointer;padding:4px 6px;font-size:13px;">
                                        <i class="fas fa-eye"></i>
                                    </button>
                                </div>
                                <div style="font-size:11px;color:var(--text-secondary);margin-top:4px;">Token 需勾选 <strong>repo</strong> 权限 (Full control of private repositories)</div>
                            </div>

                            <div style="display:grid;grid-template-columns:2fr 1fr;gap:10px;">
                                <div>
                                    <label style="display:block;font-size:12px;font-weight:700;color:var(--text-primary);margin-bottom:6px;">
                                        保存文件路径
                                    </label>
                                    <input id="gh-input-path" type="text" placeholder="backup/chatapp-backup.json"
                                        style="width:100%;padding:9px 12px;border:1.5px solid var(--border-color);border-radius:12px;background:var(--primary-bg);color:var(--text-primary);font-size:12.5px;outline:none;box-sizing:border-box;font-family:monospace;">
                                </div>
                                <div>
                                    <label style="display:block;font-size:12px;font-weight:700;color:var(--text-primary);margin-bottom:6px;">
                                        分支名
                                    </label>
                                    <input id="gh-input-branch" type="text" placeholder="main"
                                        style="width:100%;padding:9px 12px;border:1.5px solid var(--border-color);border-radius:12px;background:var(--primary-bg);color:var(--text-primary);font-size:12.5px;outline:none;box-sizing:border-box;font-family:monospace;">
                                </div>
                            </div>

                            <!-- 设置操作按钮 -->
                            <div style="display:flex;gap:10px;margin-top:4px;">
                                <button id="gh-test-btn" type="button" style="flex:1;padding:11px;border:1.5px solid var(--border-color);border-radius:12px;background:var(--primary-bg);color:var(--text-primary);font-size:13px;font-weight:600;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:6px;">
                                    <i class="fas fa-vial"></i><span>测试连接</span>
                                </button>
                                <button id="gh-save-btn" type="button" style="flex:1;padding:11px;border:none;border-radius:12px;background:var(--accent-color);color:#fff;font-size:13px;font-weight:600;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:6px;">
                                    <i class="fas fa-check"></i><span>保存配置</span>
                                </button>
                            </div>

                            <div id="gh-settings-status" style="display:none;padding:10px 12px;border-radius:10px;font-size:12px;text-align:center;line-height:1.5;"></div>
                        </div>

                    </div>

                    <!-- 底部提示 -->
                    <div style="padding:10px 20px 12px;background:var(--primary-bg);border-top:1px solid var(--border-color);display:flex;align-items:center;justify-content:space-between;font-size:11px;color:var(--text-secondary);flex-shrink:0;">
                        <span style="display:flex;align-items:center;gap:5px;">
                            <i class="fas fa-shield-alt" style="color:var(--accent-color)"></i>本地直连 GitHub API，绝不经过第三方服务器
                        </span>
                    </div>
                </div>
            `;

            this.bindEvents(modal);
        },

        updateModalData(modal) {
            const cfg = this.getConfig();
            const hasCreds = !!(cfg.owner && cfg.repo && cfg.token);

            // 更新输入框内容
            const ownerInput = modal.querySelector('#gh-input-owner');
            const repoInput = modal.querySelector('#gh-input-repo');
            const tokenInput = modal.querySelector('#gh-input-token');
            const pathInput = modal.querySelector('#gh-input-path');
            const branchInput = modal.querySelector('#gh-input-branch');

            if (ownerInput) ownerInput.value = cfg.owner || '';
            if (repoInput) repoInput.value = cfg.repo || '';
            if (tokenInput) tokenInput.value = cfg.token || '';
            if (pathInput) pathInput.value = cfg.path || 'backup/chatapp-backup.json';
            if (branchInput) branchInput.value = cfg.branch || 'main';

            // 更新配置与未配置卡片
            const unconfiguredCard = modal.querySelector('#gh-unconfigured-card');
            const configuredCard = modal.querySelector('#gh-configured-card');
            const displayRepo = modal.querySelector('#gh-display-repo');
            const displayPath = modal.querySelector('#gh-display-path');
            const displayBranch = modal.querySelector('#gh-display-branch');
            const lastTime = modal.querySelector('#gh-last-time');

            if (hasCreds) {
                if (unconfiguredCard) unconfiguredCard.style.display = 'none';
                if (configuredCard) configuredCard.style.display = 'block';
                if (displayRepo) displayRepo.textContent = `${cfg.owner}/${cfg.repo}`;
                if (displayPath) displayPath.textContent = cfg.path || 'backup/chatapp-backup.json';
                if (displayBranch) displayBranch.textContent = cfg.branch || 'main';
                if (lastTime) {
                    lastTime.textContent = cfg.lastBackupTime ? new Date(cfg.lastBackupTime).toLocaleString() : '暂无记录';
                }
            } else {
                if (unconfiguredCard) unconfiguredCard.style.display = 'block';
                if (configuredCard) configuredCard.style.display = 'none';
            }
        },

        switchTab(modal, tabName) {
            const syncBtn = modal.querySelector('#gh-tab-btn-sync');
            const settingsBtn = modal.querySelector('#gh-tab-btn-settings');
            const syncPanel = modal.querySelector('#gh-panel-sync');
            const settingsPanel = modal.querySelector('#gh-panel-settings');

            if (tabName === 'settings') {
                if (syncBtn) {
                    syncBtn.style.borderBottomColor = 'transparent';
                    syncBtn.style.color = 'var(--text-secondary)';
                }
                if (settingsBtn) {
                    settingsBtn.style.borderBottomColor = 'var(--accent-color)';
                    settingsBtn.style.color = 'var(--accent-color)';
                }
                if (syncPanel) syncPanel.style.display = 'none';
                if (settingsPanel) settingsPanel.style.display = 'flex';
            } else {
                if (syncBtn) {
                    syncBtn.style.borderBottomColor = 'var(--accent-color)';
                    syncBtn.style.color = 'var(--accent-color)';
                }
                if (settingsBtn) {
                    settingsBtn.style.borderBottomColor = 'transparent';
                    settingsBtn.style.color = 'var(--text-secondary)';
                }
                if (syncPanel) syncPanel.style.display = 'flex';
                if (settingsPanel) settingsPanel.style.display = 'none';
            }
        },

        bindEvents(modal) {
            // 背景点击关闭
            modal.onclick = (e) => {
                if (e.target === modal) this.closeModal();
            };

            // 关闭按钮
            const closeBtn = modal.querySelector('#gh-modal-close');
            if (closeBtn) closeBtn.onclick = () => this.closeModal();

            // Tab 切换
            const syncBtn = modal.querySelector('#gh-tab-btn-sync');
            const settingsBtn = modal.querySelector('#gh-tab-btn-settings');
            if (syncBtn) syncBtn.onclick = () => this.switchTab(modal, 'sync');
            if (settingsBtn) settingsBtn.onclick = () => this.switchTab(modal, 'settings');

            // 快捷跳转去设置
            const gotoSettingsBtn = modal.querySelector('#gh-goto-settings-btn');
            if (gotoSettingsBtn) {
                gotoSettingsBtn.onclick = () => this.switchTab(modal, 'settings');
            }

            // 查看/隐藏 Token
            const toggleTokenBtn = modal.querySelector('#gh-toggle-token');
            const tokenInput = modal.querySelector('#gh-input-token');
            if (toggleTokenBtn && tokenInput) {
                toggleTokenBtn.onclick = () => {
                    const isPass = tokenInput.type === 'password';
                    tokenInput.type = isPass ? 'text' : 'password';
                    toggleTokenBtn.innerHTML = isPass ? '<i class="fas fa-eye-slash"></i>' : '<i class="fas fa-eye"></i>';
                };
            }

            // 测试连接按钮
            const testBtn = modal.querySelector('#gh-test-btn');
            const settingsStatus = modal.querySelector('#gh-settings-status');
            if (testBtn) {
                testBtn.onclick = async () => {
                    const owner = modal.querySelector('#gh-input-owner')?.value.trim();
                    const repo = modal.querySelector('#gh-input-repo')?.value.trim();
                    const token = modal.querySelector('#gh-input-token')?.value.trim();

                    if (!owner || !repo || !token) {
                        this.showStatus(settingsStatus, '请完整填写用户名、仓库名和 Token', 'error');
                        return;
                    }

                    testBtn.disabled = true;
                    testBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i><span>检测中...</span>';
                    this.showStatus(settingsStatus, '正在连接 GitHub API...', 'info');

                    try {
                        const info = await this.testConnection({ owner, repo, token });
                        this.showStatus(settingsStatus, `✓ 连接成功！仓库: ${info.repoName} (${info.isPrivate ? '私有' : '公开'})`, 'success');
                    } catch (err) {
                        this.showStatus(settingsStatus, `✕ 连接失败: ${err.message}`, 'error');
                    } finally {
                        testBtn.disabled = false;
                        testBtn.innerHTML = '<i class="fas fa-vial"></i><span>测试连接</span>';
                    }
                };
            }

            // 保存设置按钮
            const saveBtn = modal.querySelector('#gh-save-btn');
            if (saveBtn) {
                saveBtn.onclick = () => {
                    const owner = modal.querySelector('#gh-input-owner')?.value.trim();
                    const repo = modal.querySelector('#gh-input-repo')?.value.trim();
                    const token = modal.querySelector('#gh-input-token')?.value.trim();
                    const path = modal.querySelector('#gh-input-path')?.value.trim() || 'backup/chatapp-backup.json';
                    const branch = modal.querySelector('#gh-input-branch')?.value.trim() || 'main';

                    if (!owner || !repo || !token) {
                        this.showStatus(settingsStatus, '请完整填写用户名、仓库名和 Token', 'error');
                        return;
                    }

                    this.saveConfig({ owner, repo, token, path, branch });
                    if (typeof showNotification === 'function') showNotification('GitHub 配置已保存', 'success');
                    this.showStatus(settingsStatus, '✓ 配置已保存成功', 'success');

                    this.updateModalData(modal);

                    setTimeout(() => {
                        this.switchTab(modal, 'sync');
                    }, 800);
                };
            }

            // 上传备份按钮
            const uploadBtn = modal.querySelector('#gh-upload-btn');
            const actionStatus = modal.querySelector('#gh-action-status');
            if (uploadBtn) {
                uploadBtn.onclick = async () => {
                    const inclMsgs = !!modal.querySelector('#gh-opt-msgs')?.checked;
                    const inclSet = !!modal.querySelector('#gh-opt-set')?.checked;
                    const inclCustom = !!modal.querySelector('#gh-opt-custom')?.checked;
                    const inclAnn = !!modal.querySelector('#gh-opt-ann')?.checked;
                    const inclThemes = !!modal.querySelector('#gh-opt-themes')?.checked;
                    const inclDg = !!modal.querySelector('#gh-opt-dg')?.checked;

                    if (!inclMsgs && !inclSet && !inclCustom && !inclAnn && !inclThemes && !inclDg) {
                        this.showStatus(actionStatus, '请至少选择一项要备份的内容', 'error');
                        return;
                    }

                    uploadBtn.disabled = true;
                    uploadBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i><span>正在打包并上传...</span>';
                    this.showStatus(actionStatus, '正在构建备份数据并上传至 GitHub...', 'info');

                    try {
                        const res = await this.uploadBackup({
                            inclMsgs, inclSet, inclCustom, inclAnn, inclThemes, inclDg
                        });
                        const sizeKb = (res.size / 1024).toFixed(1);
                        this.showStatus(actionStatus, `✓ 备份成功！文件大小: ${sizeKb} KB<br><a href="${res.url}" target="_blank" style="color:var(--accent-color);text-decoration:underline;">在 GitHub 上查看提交</a>`, 'success');
                        
                        const timeEl = modal.querySelector('#gh-last-time');
                        if (timeEl) timeEl.textContent = new Date(res.time).toLocaleString();

                        if (typeof showNotification === 'function') showNotification('已成功备份到 GitHub', 'success');
                    } catch (err) {
                        console.error('[GitHubBackup] 上传失败:', err);
                        this.showStatus(actionStatus, `✕ 上传失败: ${err.message}`, 'error');
                    } finally {
                        uploadBtn.disabled = false;
                        uploadBtn.innerHTML = '<i class="fas fa-cloud-arrow-up"></i><span>立即备份至 GitHub</span>';
                    }
                };
            }

            // 从 GitHub 恢复按钮
            const restoreBtn = modal.querySelector('#gh-restore-btn');
            if (restoreBtn) {
                restoreBtn.onclick = async () => {
                    restoreBtn.disabled = true;
                    restoreBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i><span>正在获取备份...</span>';
                    this.showStatus(actionStatus, '正在从 GitHub 下载并解析备份文件...', 'info');

                    try {
                        const { fileInfo, backupData } = await this.fetchBackup();
                        const dateStr = backupData.exportDate || backupData.timestamp || backupData.githubBackupMeta?.syncedAt || '未知时间';
                        const msgsCount = (backupData.messages && backupData.messages.length) || 0;

                        const confirmMsg = `已从 GitHub 获取到备份文件！\n\n- 备份时间: ${dateStr}\n- 包含消息: ${msgsCount} 条\n\n确定要恢复此备份并覆盖当前数据吗？`;
                        if (!confirm(confirmMsg)) {
                            this.showStatus(actionStatus, '已取消恢复操作', 'info');
                            return;
                        }

                        this.showStatus(actionStatus, '正在恢复本地数据...', 'info');
                        await this.restoreBackup(backupData);

                        this.showStatus(actionStatus, '✓ 数据恢复成功！页面即将刷新以应用最新数据...', 'success');
                        if (typeof showNotification === 'function') showNotification('数据恢复成功，即将刷新', 'success');

                        setTimeout(() => {
                            location.reload();
                        }, 1500);
                    } catch (err) {
                        console.error('[GitHubBackup] 恢复失败:', err);
                        this.showStatus(actionStatus, `✕ 恢复失败: ${err.message}`, 'error');
                    } finally {
                        restoreBtn.disabled = false;
                        restoreBtn.innerHTML = '<i class="fas fa-cloud-arrow-down" style="color:var(--accent-color)"></i><span>从 GitHub 恢复数据</span>';
                    }
                };
            }
        },

        showStatus(container, text, type = 'info') {
            if (!container) return;
            container.style.display = 'block';
            if (type === 'success') {
                container.style.background = 'rgba(59,200,164,0.12)';
                container.style.color = '#20A882';
                container.style.border = '1px solid rgba(59,200,164,0.25)';
            } else if (type === 'error') {
                container.style.background = 'rgba(240,96,96,0.12)';
                container.style.color = '#D03030';
                container.style.border = '1px solid rgba(240,96,96,0.25)';
            } else {
                container.style.background = 'rgba(var(--accent-color-rgb),0.1)';
                container.style.color = 'var(--text-primary)';
                container.style.border = '1px solid var(--border-color)';
            }
            container.innerHTML = text;
        },

        escapeHtml(str) {
            return String(str || '')
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;');
        }
    };

    window.GitHubBackup = GitHubBackup;
    window.openGitHubBackupModal = function(tab) { GitHubBackup.openModal(tab); };
    window._openGitHubBackupModal = function(tab) { GitHubBackup.openModal(tab); };
})();
