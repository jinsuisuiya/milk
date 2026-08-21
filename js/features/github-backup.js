/**
 * GitHub 云端备份与同步模块 (GitHub Cloud Backup & Restore Module)
 * 允许用户通过 GitHub Token、用户名、仓库名将传讯数据安全备份至 GitHub 私有/公开仓库，并支持一键恢复。
 * 支持超大文件 (最高 100MB)、ZIP/JSON 自动压缩、文件夹自动扫描检索与多版本备份选择。
 */

(function() {
    'use strict';

    const CONFIG_KEY = 'chatapp_github_backup_config';
    // GitHub 单文件备份过大时容易触发 API / 浏览器 / 网络限制。自动切成 8 MiB 分片。
    const LARGE_BACKUP_CHUNK_SIZE = 8 * 1024 * 1024;
    const LARGE_BACKUP_MANIFEST_SUFFIX = '.manifest.json';

    // 默认配置（默认优先使用 .zip 格式，体积小 80-90% 且解析极度稳定）
    const DEFAULT_CONFIG = {
        owner: '',
        repo: '',
        token: '',
        path: 'backup/chatapp-backup.zip',
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

        // 原生高效 Base64 转换（基于 Blob + FileReader，无调用栈溢出，支持百兆大文件）
        async arrayBufferToBase64(buffer) {
            return new Promise((resolve, reject) => {
                const blob = new Blob([buffer], { type: 'application/octet-stream' });
                const reader = new FileReader();
                reader.onload = () => {
                    const dataUrl = reader.result || '';
                    const commaIdx = dataUrl.indexOf(',');
                    resolve(commaIdx !== -1 ? dataUrl.substring(commaIdx + 1) : '');
                };
                reader.onerror = (e) => reject(new Error('Base64 编码失败: ' + e.message));
                reader.readAsDataURL(blob);
            });
        },

        async stringToBase64(str) {
            const u8 = new TextEncoder().encode(str);
            return await this.arrayBufferToBase64(u8.buffer);
        },

        // Base64 转 ArrayBuffer
        async base64ToArrayBuffer(b64) {
            const clean = b64.replace(/\s/g, '');
            try {
                const res = await fetch(`data:application/octet-stream;base64,${clean}`);
                return await res.arrayBuffer();
            } catch (e) {
                const binary = atob(clean);
                const len = binary.length;
                const bytes = new Uint8Array(len);
                for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
                return bytes.buffer;
            }
        },

        // Base64 转 UTF-8 字符串
        async base64ToUtf8(b64) {
            const ab = await this.base64ToArrayBuffer(b64);
            return new TextDecoder('utf-8').decode(ab);
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

        // 获取远端路径信息（兼容单文件与文件夹）
        async getRemoteFileInfo(cfgInput, specificPath) {
            const cfg = cfgInput || this.getConfig();
            const token = (cfg.token || '').trim();
            const owner = (cfg.owner || '').trim();
            const repo = (cfg.repo || '').trim();
            let path = (specificPath || cfg.path || 'backup/chatapp-backup.zip').trim();
            // 去除首部的斜杠
            path = path.replace(/^\/+/, '');
            const branch = (cfg.branch || 'main').trim();

            const headers = {
                'Authorization': `token ${token}`,
                'Accept': 'application/vnd.github.v3+json',
                'User-Agent': 'ChatApp-Backup'
            };

            const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodeURI(path)}?ref=${encodeURIComponent(branch)}`;
            const res = await fetch(url, { headers });

            if (res.status === 404) {
                return { exists: false, isDir: false };
            }
            if (!res.ok) {
                if (res.status === 401) throw new Error('Token 无效或已过期');
                throw new Error(`获取文件信息失败 (${res.status})`);
            }

            const data = await res.json();
            if (Array.isArray(data)) {
                return {
                    exists: true,
                    isDir: true,
                    entries: data
                };
            }

            return {
                exists: true,
                isDir: false,
                sha: data.sha,
                size: data.size,
                downloadUrl: data.download_url,
                htmlUrl: data.html_url,
                content: data.content,
                encoding: data.encoding,
                name: data.name,
                path: data.path
            };
        },

        // 列出仓库/目录中的所有备份文件（智能识别 .zip, .json, .gz 等备份文件，支持递归整库检索）
        async listRemoteBackups(cfgInput, specificFolder) {
            const cfg = cfgInput || this.getConfig();
            const token = (cfg.token || '').trim();
            const owner = (cfg.owner || '').trim();
            const repo = (cfg.repo || '').trim();
            const branch = (cfg.branch || 'main').trim();

            let folderPath = specificFolder !== undefined ? specificFolder : (cfg.path || 'backup/chatapp-backup.zip');
            folderPath = folderPath.trim().replace(/^\/+/, '');
            if (/\.[a-zA-Z0-9]+$/.test(folderPath)) {
                const slashIdx = folderPath.lastIndexOf('/');
                folderPath = slashIdx !== -1 ? folderPath.substring(0, slashIdx) : '';
            } else {
                folderPath = folderPath.replace(/\/+$/, '');
            }

            const headers = {
                'Authorization': `token ${token}`,
                'Accept': 'application/vnd.github.v3+json',
                'User-Agent': 'ChatApp-Backup'
            };

            const backupCandidates = [];

            // 1. 首选方案：Git Trees API 递归整库检索（单次请求秒级解析全部文件与子文件夹，无视目录体量）
            try {
                const treeUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(branch)}?recursive=1`;
                const treeRes = await fetch(treeUrl, { headers });
                if (treeRes.ok) {
                    const treeData = await treeRes.json();
                    if (treeData && Array.isArray(treeData.tree)) {
                        for (const item of treeData.tree) {
                            if (item.type !== 'blob') continue;
                            const p = item.path || '';
                            const name = p.split('/').pop() || '';
                            const lowerName = name.toLowerCase();
                            const isBackup = lowerName.endsWith('.zip') || lowerName.endsWith('.json') || lowerName.endsWith('.gz') || lowerName.includes('backup') || lowerName.includes('chatapp');
                            if (!isBackup) continue;

                            // 如果指定了文件夹，优先匹配该文件夹下的文件
                            if (folderPath && !p.startsWith(folderPath + '/') && p !== folderPath) {
                                // 仍保留作为全局备选，但标记优先级
                            }

                            backupCandidates.push({
                                name: name,
                                path: p,
                                size: item.size || 0,
                                sha: item.sha,
                                downloadUrl: `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${p}`,
                                htmlUrl: `https://github.com/${owner}/${repo}/blob/${branch}/${p}`
                            });
                        }

                        if (backupCandidates.length > 0) {
                            // 排序：同等条件下，如果在指定目录下的排在前面，其余按名称逆序（最新通常靠前）
                            backupCandidates.sort((a, b) => {
                                const aInFolder = folderPath ? a.path.startsWith(folderPath) : false;
                                const bInFolder = folderPath ? b.path.startsWith(folderPath) : false;
                                if (aInFolder && !bInFolder) return -1;
                                if (!aInFolder && bInFolder) return 1;
                                return b.name.localeCompare(a.name);
                            });
                            return backupCandidates;
                        }
                    }
                }
            } catch (treeErr) {
                console.warn('[GitHubBackup] Git Trees 递归获取失败，回退 Contents API:', treeErr);
            }

            // 2. 回退方案：Contents API 逐级目录检索
            const tryFetchFolder = async (dir) => {
                const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodeURI(dir)}?ref=${encodeURIComponent(branch)}`;
                const res = await fetch(url, { headers });
                if (!res.ok) return [];
                const data = await res.json();
                return Array.isArray(data) ? data : (data.name ? [data] : []);
            };

            let items = await tryFetchFolder(folderPath);
            if ((!items || items.length === 0) && folderPath !== '' && folderPath !== 'backup') {
                const backupItems = await tryFetchFolder('backup');
                if (backupItems.length > 0) items = backupItems;
            }
            if (!items || items.length === 0) {
                const rootItems = await tryFetchFolder('');
                if (rootItems.length > 0) items = rootItems;
            }

            const backupFiles = items.filter(item => {
                if (item.type !== 'file') return false;
                const name = (item.name || '').toLowerCase();
                return name.endsWith('.zip') || name.endsWith('.json') || name.endsWith('.gz') || name.includes('backup') || name.includes('chatapp');
            }).map(item => ({
                name: item.name,
                path: item.path,
                size: item.size || 0,
                sha: item.sha,
                downloadUrl: item.download_url,
                htmlUrl: item.html_url
            }));

            backupFiles.sort((a, b) => b.name.localeCompare(a.name));
            return backupFiles;
        },

        // 从 GitHub 下载任意大文件二进制（支持高达 100MB 媒体大文件，通过 Git Blobs API 规避 1MB Contents 限制）
        async downloadRemoteFileBinary(owner, repo, branch, filePath, token, knownSha) {
            const headers = {
                'Authorization': `token ${token}`,
                'Accept': 'application/vnd.github.v3.raw',
                'User-Agent': 'ChatApp-Backup'
            };

            let sha = knownSha;
            let actualPath = filePath;

            // 1. 如果没有传入 sha，先通过 contents API 获取文件元数据与 sha
            if (!sha) {
                const metaUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodeURI(filePath)}?ref=${encodeURIComponent(branch)}`;
                const metaRes = await fetch(metaUrl, {
                    headers: {
                        'Authorization': `token ${token}`,
                        'Accept': 'application/vnd.github.v3+json',
                        'User-Agent': 'ChatApp-Backup'
                    }
                });

                if (metaRes.status === 404) {
                    throw new Error(`仓库中未找到文件: ${filePath}`);
                }
                if (!metaRes.ok) {
                    if (metaRes.status === 401) throw new Error('Token 无效或已过期');
                    throw new Error(`获取文件元数据失败 (${metaRes.status})`);
                }

                const meta = await metaRes.json();
                // 如果返回的是文件夹列表数组，自动从中选取最优备份文件而不是报错中断
                if (Array.isArray(meta)) {
                    const validFiles = meta.filter(item => {
                        const n = (item.name || '').toLowerCase();
                        return n.endsWith('.zip') || n.endsWith('.json') || n.endsWith('.gz') || n.includes('backup');
                    });
                    if (validFiles.length > 0) {
                        validFiles.sort((a, b) => b.name.localeCompare(a.name));
                        sha = validFiles[0].sha;
                        actualPath = validFiles[0].path;
                    } else {
                        throw new Error(`文件夹 "${filePath}" 内暂无识别到的备份文件（.zip/.json）`);
                    }
                } else {
                    sha = meta.sha;
                    if (meta.content && meta.encoding === 'base64') {
                        return await this.base64ToArrayBuffer(meta.content);
                    }
                }
            }

            // 2. 核心大文件拉取方案：利用 Git Data Blobs API (配合 raw header，支持百兆大文件且不产生内存膨胀)
            if (sha) {
                try {
                    const blobUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/blobs/${sha}`;
                    const blobRes = await fetch(blobUrl, { headers });
                    if (blobRes.ok) {
                        const contentType = blobRes.headers.get('content-type') || '';
                        if (contentType.includes('application/json')) {
                            const blobJson = await blobRes.json();
                            if (blobJson.content && blobJson.encoding === 'base64') {
                                return await this.base64ToArrayBuffer(blobJson.content);
                            }
                        } else {
                            return await blobRes.arrayBuffer();
                        }
                    }
                } catch (e) {
                    console.warn('[GitHubBackup] Git Blobs Raw 拉取异常，尝试回退接口:', e);
                }
            }

            // 3. 回退方案：Contents Raw 流式下载
            try {
                const rawUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodeURI(actualPath)}?ref=${encodeURIComponent(branch)}`;
                const rawRes = await fetch(rawUrl, { headers });
                if (rawRes.ok) {
                    return await rawRes.arrayBuffer();
                }
            } catch (e2) {}

            // 4. 回退方案：raw.githubusercontent.com
            try {
                const rawUserUrl = `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(branch)}/${encodeURI(actualPath)}`;
                const rawUserRes = await fetch(rawUserUrl, {
                    headers: { 'Authorization': `token ${token}` }
                });
                if (rawUserRes.ok) {
                    return await rawUserRes.arrayBuffer();
                }
            } catch (e3) {}

            throw new Error(`无法从 GitHub 下载文件: ${actualPath}`);
        },

        // 大备份分片上传：多个 8 MiB blob + 一个 manifest，一次 commit 完成。
        async uploadBackupInChunks(cfg, path, branch, rawBuffer, commitMessage) {
            const token = (cfg.token || '').trim();
            const owner = (cfg.owner || '').trim();
            const repo = (cfg.repo || '').trim();
            const headers = {
                'Authorization': `token ${token}`,
                'Accept': 'application/vnd.github.v3+json',
                'Content-Type': 'application/json',
                'User-Agent': 'ChatApp-Backup'
            };

            const chunkSize = LARGE_BACKUP_CHUNK_SIZE;
            const total = Math.ceil(rawBuffer.byteLength / chunkSize);
            const basePath = path.replace(/\.zip$/i, '');
            const manifestPath = path + LARGE_BACKUP_MANIFEST_SUFFIX;
            const chunks = [];
            const blobEntries = [];

            for (let i = 0; i < total; i++) {
                const start = i * chunkSize;
                const end = Math.min(rawBuffer.byteLength, start + chunkSize);
                const chunk = rawBuffer.slice(start, end);
                const partNo = String(i + 1).padStart(3, '0');
                const chunkPath = `${basePath}.part-${partNo}`;
                const chunkB64 = await this.arrayBufferToBase64(chunk);

                const blobRes = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/blobs`, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({ content: chunkB64, encoding: 'base64' })
                });
                if (!blobRes.ok) {
                    const err = await blobRes.json().catch(() => ({}));
                    throw new Error(`上传备份分片 ${i + 1}/${total} 失败 (${blobRes.status}): ${err.message || blobRes.statusText}`);
                }
                const blob = await blobRes.json();
                chunks.push({ index: i + 1, path: chunkPath, sha: blob.sha, size: chunk.byteLength });
                blobEntries.push({ path: chunkPath, mode: '100644', type: 'blob', sha: blob.sha });
            }

            const manifest = {
                type: 'chatapp-backup-manifest',
                formatVersion: 1,
                originalPath: path,
                originalSize: rawBuffer.byteLength,
                chunkSize,
                totalChunks: total,
                chunks,
                createdAt: new Date().toISOString()
            };
            const manifestBlobRes = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/blobs`, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    content: await this.stringToBase64(JSON.stringify(manifest)),
                    encoding: 'base64'
                })
            });
            if (!manifestBlobRes.ok) {
                const err = await manifestBlobRes.json().catch(() => ({}));
                throw new Error(`上传备份索引失败 (${manifestBlobRes.status}): ${err.message || manifestBlobRes.statusText}`);
            }
            const manifestBlob = await manifestBlobRes.json();
            blobEntries.push({ path: manifestPath, mode: '100644', type: 'blob', sha: manifestBlob.sha });

            const branchRes = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches/${encodeURIComponent(branch)}`, { headers });
            let latestCommitSha = null;
            let baseTreeSha = null;
            if (branchRes.ok) {
                const branchData = await branchRes.json();
                latestCommitSha = branchData.commit?.sha;
                baseTreeSha = branchData.commit?.commit?.tree?.sha;
            }

            const treeBody = { tree: blobEntries };
            if (baseTreeSha) treeBody.base_tree = baseTreeSha;
            const treeRes = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees`, {
                method: 'POST', headers, body: JSON.stringify(treeBody)
            });
            if (!treeRes.ok) {
                const err = await treeRes.json().catch(() => ({}));
                throw new Error(`创建分片备份文件树失败 (${treeRes.status}): ${err.message || treeRes.statusText}`);
            }
            const treeData = await treeRes.json();

            const commitRes = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/commits`, {
                method: 'POST', headers, body: JSON.stringify({
                    message: commitMessage + ` [分片 ${total}×8MiB]`,
                    tree: treeData.sha,
                    parents: latestCommitSha ? [latestCommitSha] : []
                })
            });
            if (!commitRes.ok) {
                const err = await commitRes.json().catch(() => ({}));
                throw new Error(`创建分片备份提交失败 (${commitRes.status}): ${err.message || commitRes.statusText}`);
            }
            const commitData = await commitRes.json();

            const refUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/refs/heads/${encodeURIComponent(branch)}`;
            let refRes = await fetch(refUrl, {
                method: 'PATCH', headers, body: JSON.stringify({ sha: commitData.sha, force: true })
            });
            if (refRes.status === 404 || refRes.status === 422) {
                refRes = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/refs`, {
                    method: 'POST', headers, body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commitData.sha })
                });
            }
            if (!refRes.ok) {
                const err = await refRes.json().catch(() => ({}));
                throw new Error(`更新分支失败 (${refRes.status}): ${err.message || refRes.statusText}`);
            }

            return {
                sha: commitData.sha,
                url: `https://github.com/${owner}/${repo}/commit/${commitData.sha}`,
                manifestPath,
                chunks: total
            };
        },

        // 上传备份至 GitHub (支持普通 ZIP 与自动分片大 ZIP)
        async uploadBackup(options = {}) {
            const cfg = this.getConfig();
            const token = (cfg.token || '').trim();
            const owner = (cfg.owner || '').trim();
            const repo = (cfg.repo || '').trim();
            let path = (cfg.path || 'backup/chatapp-backup.zip').trim().replace(/^\/+/, '');
            const branch = (cfg.branch || 'main').trim();

            if (!owner || !repo || !token) {
                throw new Error('请先在设置中填写 GitHub 用户名、仓库名和 Token');
            }

            // 如果路径是一个目录名，自动补齐标准文件名
            if (!/\.[a-zA-Z0-9]+$/.test(path)) {
                path = path.replace(/\/+$/, '') + '/chatapp-backup.zip';
            }

            // 1. 构建备份数据包
            if (typeof ChatBackup === 'undefined' || !ChatBackup.buildBackupPayload) {
                throw new Error('备份引擎未就绪，请刷新页面后重试');
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

            let rawBuffer = null;
            const isZipTarget = path.toLowerCase().endsWith('.zip') || (typeof JSZip !== 'undefined' && !path.toLowerCase().endsWith('.json'));

            // 优先使用 ZIP 打包（体积减小 80%-90%，更省带宽，大文件夹极速同步）
            if (isZipTarget && typeof JSZip !== 'undefined' && typeof ChatBackup.buildZipArrayBuffer === 'function') {
                rawBuffer = await ChatBackup.buildZipArrayBuffer(payload);
                if (!path.toLowerCase().endsWith('.zip') && !path.toLowerCase().endsWith('.json')) {
                    path += '.zip';
                }
            } else {
                const jsonStr = ChatBackup.serializeBackupV4 ? ChatBackup.serializeBackupV4(payload) : JSON.stringify(payload);
                rawBuffer = new TextEncoder().encode(jsonStr).buffer;
            }

            const fileSize = rawBuffer.byteLength;

            // 超过 8 MiB 自动分片，避免 GitHub 单文件上传/下载在移动端或网络不稳定时失败。
            if (fileSize > LARGE_BACKUP_CHUNK_SIZE) {
                const chunkCommitMessage = options.commitMessage || `Data Backup: ${new Date().toLocaleString()} (传讯ZIP大文件分片备份 - ${(fileSize / 1024 / 1024).toFixed(1)} MB)`;
                const chunkResult = await this.uploadBackupInChunks(cfg, path, branch, rawBuffer, chunkCommitMessage);
                const nowTime = new Date().toISOString();
                this.saveConfig({
                    path: chunkResult.manifestPath,
                    lastBackupTime: nowTime,
                    lastBackupSha: chunkResult.sha,
                    lastBackupUrl: chunkResult.url
                });
                return {
                    ok: true,
                    time: nowTime,
                    sha: chunkResult.sha,
                    url: chunkResult.url,
                    size: fileSize,
                    path: chunkResult.manifestPath,
                    chunks: chunkResult.chunks
                };
            }

            // 2. 转换为高效 Base64
            const base64Content = await this.arrayBufferToBase64(rawBuffer);

            const isZipFormat = isZipTarget && typeof JSZip !== 'undefined';
            const formatTag = isZipFormat ? 'ZIP' : 'JSON';
            const commitMessage = options.commitMessage || `Data Backup: ${new Date().toLocaleString()} (传讯${formatTag}备份 - ${(fileSize / 1024).toFixed(1)} KB)`;
            
            const headers = {
                'Authorization': `token ${token}`,
                'Accept': 'application/vnd.github.v3+json',
                'Content-Type': 'application/json',
                'User-Agent': 'ChatApp-Backup'
            };

            let commitUrl = `https://github.com/${owner}/${repo}/blob/${branch}/${path}`;
            let newSha = null;

            // 3. 智能选择上传策略：
            // 如果文件小于 1MB，尝试 Contents API；如果大于 1MB 或 Contents API 报错，自动升迁为 Git Data API (Blobs -> Trees -> Commits)
            let useGitDataApi = fileSize > 1000000;

            if (!useGitDataApi) {
                try {
                    const remoteInfo = await this.getRemoteFileInfo(cfg, path);
                    const body = {
                        message: commitMessage,
                        content: base64Content,
                        branch: branch
                    };
                    if (remoteInfo.exists && !remoteInfo.isDir && remoteInfo.sha) {
                        body.sha = remoteInfo.sha;
                    }

                    const putUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodeURI(path)}`;
                    const putRes = await fetch(putUrl, {
                        method: 'PUT',
                        headers,
                        body: JSON.stringify(body)
                    });

                    if (putRes.ok) {
                        const resData = await putRes.json();
                        newSha = resData.content?.sha || resData.commit?.sha;
                        commitUrl = resData.commit?.html_url || commitUrl;
                    } else {
                        // 如果 Contents API 因文件体量或冲突返回错误，自动切换为 Git Data API
                        console.warn(`[GitHubBackup] Contents API 返回 ${putRes.status}，切换为 Git Data API 处理大文件`);
                        useGitDataApi = true;
                    }
                } catch (e) {
                    useGitDataApi = true;
                }
            }

            // 4. Git Data API 上传大文件（支持最高 100MB，不触发 Contents API 体量限制）
            if (useGitDataApi) {
                // Step A: 创建 Git Blob
                const blobUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/blobs`;
                const blobRes = await fetch(blobUrl, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({
                        content: base64Content,
                        encoding: 'base64'
                    })
                });

                if (!blobRes.ok) {
                    const err = await blobRes.json().catch(() => ({}));
                    throw new Error(`创建数据块失败 (${blobRes.status}): ${err.message || blobRes.statusText}`);
                }
                const blobData = await blobRes.json();
                const blobSha = blobData.sha;

                // Step B: 获取目标分支的最新 Commit
                const branchUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches/${encodeURIComponent(branch)}`;
                const branchRes = await fetch(branchUrl, { headers });

                let latestCommitSha = null;
                let baseTreeSha = null;

                if (branchRes.ok) {
                    const branchData = await branchRes.json();
                    latestCommitSha = branchData.commit?.sha;
                    baseTreeSha = branchData.commit?.commit?.tree?.sha;
                }

                // Step C: 创建 Tree
                const treeUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees`;
                const treeBody = {
                    tree: [{
                        path: path,
                        mode: '100644',
                        type: 'blob',
                        sha: blobSha
                    }]
                };
                if (baseTreeSha) {
                    treeBody.base_tree = baseTreeSha;
                }

                const treeRes = await fetch(treeUrl, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify(treeBody)
                });

                if (!treeRes.ok) {
                    const err = await treeRes.json().catch(() => ({}));
                    throw new Error(`创建文件树失败 (${treeRes.status}): ${err.message || treeRes.statusText}`);
                }
                const treeData = await treeRes.json();
                const newTreeSha = treeData.sha;

                // Step D: 创建 Commit
                const commitApiUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/commits`;
                const commitBody = {
                    message: commitMessage,
                    tree: newTreeSha,
                    parents: latestCommitSha ? [latestCommitSha] : []
                };

                const commitRes = await fetch(commitApiUrl, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify(commitBody)
                });

                if (!commitRes.ok) {
                    const err = await commitRes.json().catch(() => ({}));
                    throw new Error(`创建提交失败 (${commitRes.status}): ${err.message || commitRes.statusText}`);
                }
                const commitData = await commitRes.json();
                const newCommitSha = commitData.sha;

                // Step E: 更新分支引用 (Ref)
                const refUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/refs/heads/${encodeURIComponent(branch)}`;
                let refRes = await fetch(refUrl, {
                    method: 'PATCH',
                    headers,
                    body: JSON.stringify({
                        sha: newCommitSha,
                        force: true
                    })
                });

                // 如果分支尚未创建，则创建新分支引用
                if (refRes.status === 404 || refRes.status === 422) {
                    const createRefUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/refs`;
                    refRes = await fetch(createRefUrl, {
                        method: 'POST',
                        headers,
                        body: JSON.stringify({
                            ref: `refs/heads/${branch}`,
                            sha: newCommitSha
                        })
                    });
                }

                if (!refRes.ok) {
                    const err = await refRes.json().catch(() => ({}));
                    throw new Error(`更新分支引用失败 (${refRes.status}): ${err.message || refRes.statusText}`);
                }

                newSha = newCommitSha;
                commitUrl = `https://github.com/${owner}/${repo}/commit/${newCommitSha}`;
            }

            // 5. 更新本地同步状态
            const nowTime = new Date().toISOString();
            this.saveConfig({
                path: path,
                lastBackupTime: nowTime,
                lastBackupSha: newSha,
                lastBackupUrl: commitUrl
            });

            return {
                ok: true,
                time: nowTime,
                sha: newSha,
                url: commitUrl,
                size: fileSize,
                path: path
            };
        },

        // 从 GitHub 拉取备份文件 (智能识别目录、多版本备份与超大文件)
        async fetchBackup(specificFilePath) {
            const cfg = this.getConfig();
            const token = (cfg.token || '').trim();
            const owner = (cfg.owner || '').trim();
            const repo = (cfg.repo || '').trim();
            let targetPath = (specificFilePath || cfg.path || 'backup/chatapp-backup.zip').trim().replace(/^\/+/, '');
            const branch = (cfg.branch || 'main').trim();

            if (!owner || !repo || !token) {
                throw new Error('请先在设置中填写 GitHub 用户名、仓库名和 Token');
            }

            let actualFilePath = targetPath;
            let fileSha = null;

            // 1. 如果路径是目录或没有指定确切文件，先扫描该目录寻找备份文件
            const isLikelyFolder = !/\.[a-zA-Z0-9]+$/.test(targetPath);
            if (isLikelyFolder) {
                const candidates = await this.listRemoteBackups(cfg, targetPath);
                if (candidates && candidates.length > 0) {
                    // 自动选取最新的一个备份文件
                    actualFilePath = candidates[0].path;
                    fileSha = candidates[0].sha;
                } else {
                    // 尝试默认标准路径
                    actualFilePath = targetPath.replace(/\/+$/, '') + '/chatapp-backup.zip';
                }
            }

            // 2. 下载二进制文件（支持大文件 Blob 流式拉取）
            let ab = null;
            try {
                ab = await this.downloadRemoteFileBinary(owner, repo, branch, actualFilePath, token, fileSha);
            } catch (err) {
                // 如果是 zip 没找到，尝试查找同名或同目录的 json 备份文件
                if (actualFilePath.endsWith('.zip')) {
                    const fallbackJsonPath = actualFilePath.replace(/\.zip$/, '.json');
                    try {
                        ab = await this.downloadRemoteFileBinary(owner, repo, branch, fallbackJsonPath, token);
                        actualFilePath = fallbackJsonPath;
                    } catch (e2) {
                        throw err;
                    }
                } else {
                    throw err;
                }
            }

            if (!ab || ab.byteLength === 0) {
                throw new Error('未能从 GitHub 下载到有效备份数据');
            }

            // 大备份 manifest：按索引顺序下载各分片并在本地重新拼接。
            try {
                const manifestText = new TextDecoder('utf-8').decode(ab).replace(/^\uFEFF/, '').trim();
                const manifest = JSON.parse(manifestText);
                if (manifest && manifest.type === 'chatapp-backup-manifest' && Array.isArray(manifest.chunks)) {
                    const buffers = [];
                    let totalBytes = 0;
                    for (const part of manifest.chunks) {
                        if (!part || !part.path) throw new Error('备份分片索引损坏');
                        const partBuffer = await this.downloadRemoteFileBinary(owner, repo, branch, part.path, token, part.sha || null);
                        if (!partBuffer || partBuffer.byteLength === 0) throw new Error(`备份分片 ${part.index || '?'} 下载为空`);
                        buffers.push(partBuffer);
                        totalBytes += partBuffer.byteLength;
                    }
                    if (manifest.originalSize && totalBytes !== manifest.originalSize) {
                        throw new Error(`备份分片拼接后大小不一致：预期 ${(manifest.originalSize / 1024 / 1024).toFixed(1)} MB，实际 ${(totalBytes / 1024 / 1024).toFixed(1)} MB`);
                    }
                    const merged = new Uint8Array(totalBytes);
                    let offset = 0;
                    for (const partBuffer of buffers) {
                        merged.set(new Uint8Array(partBuffer), offset);
                        offset += partBuffer.byteLength;
                    }
                    ab = merged.buffer;
                    actualFilePath = manifest.originalPath || actualFilePath;
                }
            } catch (manifestErr) {
                // 普通 ZIP/JSON 不是 manifest，继续按原流程解析。只有明确识别到 manifest 时才抛出错误。
                if (manifestErr && /备份分片|分片索引|拼接后大小/.test(manifestErr.message || '')) throw manifestErr;
            }

            // 3. 使用备份引擎的万能多格式解析器解析数据（支持 ZIP、GZIP、标准 JSON、BOM 头）
            if (typeof ChatBackup === 'undefined' || !ChatBackup.loadBackupFromArrayBuffer) {
                throw new Error('备份解析引擎未就绪');
            }

            const backupData = await ChatBackup.loadBackupFromArrayBuffer(ab);
            return {
                filePath: actualFilePath,
                fileInfo: { size: ab.byteLength },
                backupData
            };
        },

        // 恢复数据到本地存储
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

            // 备份窗口作为当前页面上的独立浮层打开，不再强制关闭设置/高级设置。
            // 完成备份后关闭浮层即可回到原来的页面。
            modal.style.display = 'flex';
            modal.style.zIndex = '10050';
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
                                <div style="font-size:15px;font-weight:700;color:var(--text-primary);line-height:1.2;">GitHub 云端备份与恢复</div>
                                <div style="font-size:11px;color:var(--text-secondary);margin-top:2px;">将聊天记录与个性化设置托管至 GitHub 私有仓库</div>
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
                                    <div><i class="far fa-file-code" style="width:14px;opacity:0.7"></i> 路径: <code id="gh-display-path" style="color:var(--text-primary)">backup/chatapp-backup.zip</code> (<span id="gh-display-branch">main</span>)</div>
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
                                        <input type="checkbox" id="gh-opt-set" checked style="accent-color:var(--accent-color)"> 角色设置与头像
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

                            <!-- 备份与恢复按钮组 -->
                            <div style="display:flex;flex-direction:column;gap:10px;">
                                <button id="gh-upload-btn" type="button" style="width:100%;padding:13px;border:none;border-radius:14px;background:linear-gradient(135deg,#24292e,#1a1e22);color:#fff;font-size:14px;font-weight:600;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px;box-shadow:0 4px 14px rgba(0,0,0,0.15);transition:transform 0.15s;">
                                    <i class="fas fa-cloud-arrow-up"></i><span>立即备份至 GitHub (ZIP压缩)</span>
                                </button>

                                <div style="display:flex;gap:8px;">
                                    <button id="gh-restore-btn" type="button" style="flex:1;padding:12px;border:1.5px solid var(--border-color);border-radius:14px;background:var(--primary-bg);color:var(--text-primary);font-size:13.5px;font-weight:600;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:6px;transition:background 0.15s;">
                                        <i class="fas fa-cloud-arrow-down" style="color:var(--accent-color)"></i><span>快速恢复数据</span>
                                    </button>
                                    <button id="gh-browse-btn" type="button" title="浏览仓库目录下的全部备份版本" style="padding:12px 14px;border:1.5px solid var(--border-color);border-radius:14px;background:var(--primary-bg);color:var(--text-secondary);font-size:13px;font-weight:600;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:5px;white-space:nowrap;">
                                        <i class="fas fa-folder-open"></i><span>备份版本库</span>
                                    </button>
                                </div>
                            </div>

                            <!-- 仓库备份列表浏览器 (折叠卡片) -->
                            <div id="gh-file-browser-box" style="display:none;background:var(--primary-bg);border:1px solid var(--border-color);border-radius:16px;padding:12px 14px;">
                                <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
                                    <div style="font-size:12px;font-weight:700;color:var(--text-primary);display:flex;align-items:center;gap:6px;">
                                        <i class="fas fa-list-ul" style="color:var(--accent-color);"></i>仓库备份文件列表
                                    </div>
                                    <button id="gh-refresh-list-btn" type="button" style="background:none;border:none;color:var(--accent-color);font-size:11.5px;cursor:pointer;display:flex;align-items:center;gap:4px;">
                                        <i class="fas fa-rotate"></i>刷新
                                    </button>
                                </div>
                                <div id="gh-file-list-container" style="display:flex;flex-direction:column;gap:6px;max-height:160px;overflow-y:auto;font-size:12px;">
                                    <div style="color:var(--text-secondary);text-align:center;padding:12px 0;">点击刷新检索仓库文件...</div>
                                </div>
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
                                <div style="font-size:11px;color:var(--text-secondary);margin-top:4px;">建议在 GitHub 创建 <strong>Private（私有）</strong> 仓库以保护个人隐私</div>
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
                                    <input id="gh-input-path" type="text" placeholder="backup/chatapp-backup.zip"
                                        style="width:100%;padding:9px 12px;border:1.5px solid var(--border-color);border-radius:12px;background:var(--primary-bg);color:var(--text-primary);font-size:12.5px;outline:none;box-sizing:border-box;font-family:monospace;">
                                    <div style="font-size:10.5px;color:var(--text-secondary);margin-top:3px;">支持填具体文件 (.zip/.json) 或文件夹 (例如 backup/)</div>
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
            if (pathInput) pathInput.value = cfg.path || 'backup/chatapp-backup.zip';
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
                if (displayPath) displayPath.textContent = cfg.path || 'backup/chatapp-backup.zip';
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

        async renderBackupList(modal) {
            const container = modal.querySelector('#gh-file-list-container');
            if (!container) return;

            container.innerHTML = '<div style="color:var(--text-secondary);text-align:center;padding:12px 0;"><i class="fas fa-spinner fa-spin"></i> 正在检索仓库中的备份文件...</div>';

            try {
                const files = await this.listRemoteBackups();
                if (!files || files.length === 0) {
                    container.innerHTML = '<div style="color:var(--text-secondary);text-align:center;padding:12px 0;">仓库或目标文件夹中暂未发现 .zip / .json 备份文件</div>';
                    return;
                }

                let html = '';
                files.forEach(f => {
                    const sizeStr = f.size > 1048576 
                        ? (f.size / 1048576).toFixed(1) + ' MB' 
                        : (f.size / 1024).toFixed(0) + ' KB';
                    const isZip = f.name.endsWith('.zip');
                    const iconClass = isZip ? 'fa-file-zipper' : 'fa-file-code';

                    html += `
                        <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 10px;background:var(--secondary-bg);border:1px solid var(--border-color);border-radius:10px;gap:8px;">
                            <div style="display:flex;align-items:center;gap:8px;overflow:hidden;flex:1;">
                                <i class="fas ${iconClass}" style="color:var(--accent-color);font-size:14px;flex-shrink:0;"></i>
                                <div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
                                    <div style="font-weight:600;color:var(--text-primary);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${this.escapeHtml(f.name)}</div>
                                    <div style="font-size:10.5px;color:var(--text-secondary);">${this.escapeHtml(f.path)} · ${sizeStr}</div>
                                </div>
                            </div>
                            <button type="button" class="gh-restore-specific-btn" data-path="${this.escapeHtml(f.path)}" style="padding:4px 10px;border:none;border-radius:8px;background:var(--accent-color);color:#fff;font-size:11px;font-weight:600;cursor:pointer;white-space:nowrap;flex-shrink:0;">
                                恢复此文件
                            </button>
                        </div>
                    `;
                });

                container.innerHTML = html;

                // 绑定单文件恢复事件
                container.querySelectorAll('.gh-restore-specific-btn').forEach(btn => {
                    btn.onclick = async () => {
                        const targetPath = btn.getAttribute('data-path');
                        if (!targetPath) return;
                        await this.triggerRestore(modal, targetPath);
                    };
                });

            } catch (err) {
                container.innerHTML = `<div style="color:#D03030;text-align:center;padding:12px 0;">检索失败: ${this.escapeHtml(err.message)}</div>`;
            }
        },

        async triggerRestore(modal, specificFilePath) {
            const restoreBtn = modal.querySelector('#gh-restore-btn');
            const actionStatus = modal.querySelector('#gh-action-status');

            if (restoreBtn) restoreBtn.disabled = true;
            this.showStatus(actionStatus, '<i class="fas fa-spinner fa-spin"></i> 正在从 GitHub 下载并解析备份数据...', 'info');

            try {
                const { filePath, fileInfo, backupData } = await this.fetchBackup(specificFilePath);
                const dateStr = backupData.exportDate || backupData.timestamp || backupData.githubBackupMeta?.syncedAt || '未知时间';
                const msgsCount = (backupData.messages && backupData.messages.length) || (backupData.indexedDB?.chatMessages?.length) || 0;
                const sizeKb = fileInfo && fileInfo.size ? (fileInfo.size / 1024).toFixed(0) + ' KB' : '';

                const confirmMsg = `已从 GitHub 获取到备份文件：\n- 文件路径: ${filePath} (${sizeKb})\n- 备份时间: ${dateStr}\n- 包含消息: ${msgsCount} 条\n\n确定要恢复此备份并覆盖当前数据吗？`;
                if (!confirm(confirmMsg)) {
                    this.showStatus(actionStatus, '已取消恢复操作', 'info');
                    if (restoreBtn) restoreBtn.disabled = false;
                    return;
                }

                this.showStatus(actionStatus, '<i class="fas fa-spinner fa-spin"></i> 正在恢复本地存储与个性化数据...', 'info');
                await this.restoreBackup(backupData);

                this.showStatus(actionStatus, '✓ 数据恢复成功！页面即将刷新以应用最新数据...', 'success');
                if (typeof showNotification === 'function') showNotification('数据恢复成功，页面即将刷新', 'success');

                setTimeout(() => {
                    location.reload();
                }, 1500);
            } catch (err) {
                console.error('[GitHubBackup] 恢复失败:', err);
                this.showStatus(actionStatus, `✕ 恢复失败: ${err.message}`, 'error');
            } finally {
                if (restoreBtn) restoreBtn.disabled = false;
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

            // 浏览备份文件列表折叠开关
            const browseBtn = modal.querySelector('#gh-browse-btn');
            const fileBrowserBox = modal.querySelector('#gh-file-browser-box');
            if (browseBtn && fileBrowserBox) {
                browseBtn.onclick = () => {
                    const isHidden = fileBrowserBox.style.display === 'none';
                    fileBrowserBox.style.display = isHidden ? 'block' : 'none';
                    if (isHidden) {
                        this.renderBackupList(modal);
                    }
                };
            }

            const refreshListBtn = modal.querySelector('#gh-refresh-list-btn');
            if (refreshListBtn) {
                refreshListBtn.onclick = () => this.renderBackupList(modal);
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
                    const path = modal.querySelector('#gh-input-path')?.value.trim() || 'backup/chatapp-backup.zip';
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
                    this.showStatus(actionStatus, '正在压缩备份数据并上传至 GitHub 仓库...', 'info');

                    try {
                        const res = await this.uploadBackup({
                            inclMsgs, inclSet, inclCustom, inclAnn, inclThemes, inclDg
                        });
                        const sizeKb = (res.size / 1024).toFixed(1);
                        this.showStatus(actionStatus, `✓ 备份成功！文件: ${this.escapeHtml(res.path)} (${sizeKb} KB)<br><a href="${res.url}" target="_blank" style="color:var(--accent-color);text-decoration:underline;">在 GitHub 上查看提交</a>`, 'success');
                        
                        const timeEl = modal.querySelector('#gh-last-time');
                        if (timeEl) timeEl.textContent = new Date(res.time).toLocaleString();

                        if (typeof showNotification === 'function') showNotification('已成功备份到 GitHub', 'success');
                        
                        // 如果列表展开，自动刷新列表
                        if (fileBrowserBox && fileBrowserBox.style.display !== 'none') {
                            this.renderBackupList(modal);
                        }
                    } catch (err) {
                        console.error('[GitHubBackup] 上传失败:', err);
                        this.showStatus(actionStatus, `✕ 上传失败: ${err.message}`, 'error');
                    } finally {
                        uploadBtn.disabled = false;
                        uploadBtn.innerHTML = '<i class="fas fa-cloud-arrow-up"></i><span>立即备份至 GitHub (ZIP压缩)</span>';
                    }
                };
            }

            // 从 GitHub 恢复按钮（默认恢复最新备份）
            const restoreBtn = modal.querySelector('#gh-restore-btn');
            if (restoreBtn) {
                restoreBtn.onclick = async () => {
                    await this.triggerRestore(modal);
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
