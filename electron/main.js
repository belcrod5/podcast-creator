try {
    require('dotenv').config();
} catch (_) {
    // Ignore missing dotenv in packaged builds.
}
const { app, BrowserWindow, ipcMain, screen, clipboard, protocol, shell, nativeImage, dialog } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');
const fsPromises = fs.promises; // プロミスベースの関数と同期関数の両方を使えるようにする
let ttsService;
const os = require('os');
const { Readable } = require('stream');
const {
    createSaveRecord,
    writeSaveRecord,
    listSaveRecords,
    loadSaveRecord,
    updateSaveRecordResult
} = require('../shared/podcast-save-data');

// tts-service.jsと同じパス定義を追加
const TEMP_DIR = path.join(os.tmpdir(), 'aivis-audio');
const TEMP_BG_PATH = path.join(TEMP_DIR, 'current-bg.png');
// electron/ 配下からプロジェクトルートを指す
const APP_ROOT = path.resolve(__dirname, '..');
const APP_ICON_PATH = path.join(APP_ROOT, 'app-resources', 'app-ico.png');

let WORK_DIR = null;

const readArgValue = (args, flag) => {
    const prefix = `${flag}=`;
    for (let i = 0; i < args.length; i += 1) {
        const entry = args[i];
        if (entry === flag) {
            return args[i + 1];
        }
        if (typeof entry === 'string' && entry.startsWith(prefix)) {
            return entry.slice(prefix.length);
        }
    }
    return null;
};

const CLI_PODCAST_PATH = readArgValue(process.argv, '--podcast');
const CLI_RESUME_PATH = readArgValue(process.argv, '--resume');
const CLI_WORK_DIR = readArgValue(process.argv, '--workdir');
const IS_PODCAST_CLI = !!(
    (typeof CLI_PODCAST_PATH === 'string' && CLI_PODCAST_PATH.trim())
    || (typeof CLI_RESUME_PATH === 'string' && CLI_RESUME_PATH.trim())
);

const SETTINGS_FILE_NAME = 'podcast-creator-settings.json';

const getSettingsFilePath = () => path.join(app.getPath('userData'), SETTINGS_FILE_NAME);

const getDefaultWorkDir = () => path.join(app.getPath('documents'), 'PodCastCreator');

const getWorkDir = () => {
    if (typeof WORK_DIR !== 'string') return null;
    const trimmed = WORK_DIR.trim();
    return trimmed ? trimmed : null;
};

const readSettings = () => {
    try {
        const settingsPath = getSettingsFilePath();
        if (!fs.existsSync(settingsPath)) return {};
        const raw = fs.readFileSync(settingsPath, 'utf8');
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (error) {
        console.warn('設定ファイルの読み込みに失敗しました:', error);
        return {};
    }
};

const writeSettings = (settings) => {
    try {
        const settingsPath = getSettingsFilePath();
        fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
        fs.writeFileSync(settingsPath, JSON.stringify(settings ?? {}, null, 2), 'utf8');
        return true;
    } catch (error) {
        console.warn('設定ファイルの保存に失敗しました:', error);
        return false;
    }
};

const promptForWorkDir = async (parentWindow = null) => {
    const defaultDir = getDefaultWorkDir();

    const options = {
        title: '作業ディレクトリを選択',
        defaultPath: defaultDir,
        properties: ['openDirectory', 'createDirectory']
    };

    const result = parentWindow
        ? await dialog.showOpenDialog(parentWindow, options)
        : await dialog.showOpenDialog(options);

    if (result?.canceled) return null;
    const picked = result?.filePaths?.[0];
    if (typeof picked !== 'string') return null;
    const trimmed = picked.trim();
    return trimmed ? trimmed : null;
};

const applyWorkDir = async (nextWorkDir) => {
    if (typeof nextWorkDir !== 'string') return null;
    const trimmed = nextWorkDir.trim();
    if (!trimmed) return null;

    WORK_DIR = trimmed;
    process.env.PODCAST_CREATOR_WORKDIR = trimmed;

    const settings = readSettings();
    writeSettings({ ...settings, workDir: trimmed });

    if (ttsService && typeof ttsService.setWorkDir === 'function') {
        try {
            ttsService.setWorkDir(trimmed);
        } catch (error) {
            console.error('TTSサービスの作業ディレクトリ更新に失敗しました:', error);
        }
    }

    return trimmed;
};

const ensureWorkDir = async () => {
    const settings = readSettings();
    const saved = (typeof settings?.workDir === 'string') ? settings.workDir.trim() : '';

    if (saved && fs.existsSync(saved)) {
        try {
            if (fs.statSync(saved).isDirectory()) {
                await applyWorkDir(saved);
                return saved;
            }
        } catch (_) { /* ignore */ }
    }

    // 未設定/不正な場合はダイアログで選択させる（キャンセル時はデフォルトへフォールバック）
    const picked = await promptForWorkDir(null);
    const fallback = getDefaultWorkDir();
    const selected = picked || fallback;
    await applyWorkDir(selected);
    return selected;
};

// 開発時（electron .）でもアプリ名が「Electron」にならないようにする
app.setName('Podcast Creator');

const LOCAL_MEDIA_SCHEME = 'local-media';

const MEDIA_MIME_TYPES = {
    '.mp3': 'audio/mpeg',
    '.aac': 'audio/aac',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.flac': 'audio/flac',
    '.m4a': 'audio/mp4',
    '.mp4': 'video/mp4',
    '.m4v': 'video/x-m4v',
    '.mov': 'video/quicktime',
    '.avi': 'video/x-msvideo',
    '.wmv': 'video/x-ms-wmv',
    '.flv': 'video/x-flv',
    '.mkv': 'video/x-matroska',
    '.webm': 'video/webm'
};

const createEmptyStream = () => Readable.from(Buffer.alloc(0));

const getMimeType = (filePath) => {
    if (!filePath) return 'application/octet-stream';
    const ext = path.extname(filePath).toLowerCase();
    return MEDIA_MIME_TYPES[ext] || 'application/octet-stream';
};

const resolveLocalMediaPath = (requestUrl) => {
    if (!requestUrl) return '';

    try {
        const url = new URL(requestUrl);
        const host = url.host || '';
        let pathname = url.pathname || '';

        let combinedPath = pathname;
        if (host) {
            combinedPath = `/${host}${pathname}`;
        }

        let decodedPath = decodeURIComponent(combinedPath);

        if (process.platform === 'win32') {
            if (decodedPath.startsWith('/') && /^[a-zA-Z]:/.test(decodedPath.slice(1))) {
                decodedPath = decodedPath.slice(1);
            }
            decodedPath = decodedPath.replace(/\//g, '\\');
        }

        if (!decodedPath) {
            return '';
        }

        if (path.isAbsolute(decodedPath)) {
            // 「/videos/foo.mp4」のようなパスは、存在しない場合に限りプロジェクトルート基準として解釈する
            // （local-media://some/path をプロジェクトルート基準で扱えるようにする）
            try {
                if (!fs.existsSync(decodedPath)) {
                    const suffix = decodedPath.replace(/^\/+/, '');
                    const workDir = getWorkDir();
                    if (workDir) {
                        const asWorkRelative = path.join(workDir, suffix);
                        if (fs.existsSync(asWorkRelative)) return asWorkRelative;
                    }
                    const asProjectRelative = path.join(APP_ROOT, suffix);
                    if (fs.existsSync(asProjectRelative)) return asProjectRelative;
                }
            } catch (_) {
                /* ignore */
            }
            return decodedPath;
        }

        return path.join(getWorkDir() || APP_ROOT, decodedPath);
    } catch (error) {
        console.error('Failed to resolve local media path:', error);
        return '';
    }
};

const handleLocalMediaRequest = (request, callback) => {
    try {
        const absolutePath = resolveLocalMediaPath(request?.url);

        if (!absolutePath || !fs.existsSync(absolutePath) || fs.statSync(absolutePath).isDirectory()) {
            callback({ statusCode: 404, data: createEmptyStream() });
            return;
        }

        const stat = fs.statSync(absolutePath);
        const totalSize = stat.size;
        const mimeType = getMimeType(absolutePath);
        const rangeHeader = request?.headers?.range || request?.headers?.Range;
        const baseHeaders = {
            'Content-Type': mimeType,
            'Accept-Ranges': 'bytes'
        };

        if (rangeHeader) {
            const matches = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
            if (!matches) {
                callback({
                    statusCode: 416,
                    headers: {
                        ...baseHeaders,
                        'Content-Range': `bytes */${totalSize}`
                    },
                    data: createEmptyStream()
                });
                return;
            }

            let start = matches[1] ? parseInt(matches[1], 10) : 0;
            let end = matches[2] ? parseInt(matches[2], 10) : (totalSize - 1);

            if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= totalSize) {
                callback({
                    statusCode: 416,
                    headers: {
                        ...baseHeaders,
                        'Content-Range': `bytes */${totalSize}`
                    },
                    data: createEmptyStream()
                });
                return;
            }

            if (end >= totalSize) {
                end = totalSize - 1;
            }

            const chunkSize = (end - start) + 1;

            callback({
                statusCode: 206,
                headers: {
                    ...baseHeaders,
                    'Content-Length': String(chunkSize),
                    'Content-Range': `bytes ${start}-${end}/${totalSize}`
                },
                data: fs.createReadStream(absolutePath, { start, end })
            });
            return;
        }

        callback({
            statusCode: 200,
            headers: {
                ...baseHeaders,
                'Content-Length': String(totalSize)
            },
            data: fs.createReadStream(absolutePath)
        });
    } catch (error) {
        console.error('local-media protocol error:', error);
        callback({ statusCode: 500, data: createEmptyStream() });
    }
};

ipcMain.handle('open-external', async (_, url) => {
    try {
        if (typeof url !== 'string') {
            return { success: false, error: 'URLが不正です' };
        }
        const trimmed = url.trim();
        if (!trimmed) {
            return { success: false, error: 'URLが空です' };
        }

        let parsed;
        try {
            parsed = new URL(trimmed);
        } catch (_) {
            return { success: false, error: 'URLが不正です' };
        }

        if (!['http:', 'https:'].includes(parsed.protocol)) {
            return { success: false, error: '許可されていないURLです' };
        }

        await shell.openExternal(trimmed);
        return { success: true };
    } catch (error) {
        console.error('Error opening external URL:', error);
        return { success: false, error: error.message };
    }
});

if (process.env.NODE_ENV === 'development') {
    try {
        require('electron-reloader')(module, {
            ignore: ['*.json', '*.psd', '*.png', '*.mp3', '*.mp4']
        });
    } catch (_) { }
}

protocol.registerSchemesAsPrivileged([
    {
        scheme: 'local-media',
        privileges: {
            standard: true,
            secure: true,
            corsEnabled: true,
            supportFetchAPI: true,
            stream: true
        }
    }
]);

function waitForWebpackDevServer(url) {
    return new Promise((resolve, reject) => {
        const tryConnection = () => {
            http.get(url, (res) => {
                if (res.statusCode === 200) {
                    resolve();
                } else {
                    setTimeout(tryConnection, 1000);
                }
            }).on('error', () => {
                setTimeout(tryConnection, 1000);
            });
        };
        tryConnection();
    });
}

async function createWindow() {
    protocol.registerFileProtocol('local-image', (request, callback) => {
        try {
            const url = request.url.replace('local-image://', '');
            const decodedPath = decodeURIComponent(url);
            const resolvedPath = path.isAbsolute(decodedPath)
                ? decodedPath
                : path.join(getWorkDir() || APP_ROOT, decodedPath);
            callback({ path: resolvedPath });
        } catch (error) {
            console.error('Protocol handler error:', error);
            callback({ error: -2 /* FAILED */ });
        }
    });

    protocol.registerStreamProtocol('local-media', handleLocalMediaRequest);

    // プライマリディスプレイの取得
    const primaryDisplay = screen.getPrimaryDisplay();
    // すべてのディスプレイの取得
    const allDisplays = screen.getAllDisplays();

    // 例: セカンダリディスプレイがある場合はそちらに表示
    const targetDisplay = allDisplays.find(display => display.id !== primaryDisplay.id) || primaryDisplay;

    const win = new BrowserWindow({
        width: 1800,
        height: 1000,
        x: targetDisplay.bounds.x,
        y: targetDisplay.bounds.y,
        icon: APP_ICON_PATH,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            webSecurity: true,
            preload: path.join(__dirname, 'preload.js')
        }
    });

    if (process.env.NODE_ENV === 'development') {
        await waitForWebpackDevServer('http://localhost:3001');
        await win.loadURL('http://localhost:3001');
    } else {
        // webpackの成果物を読む（src/index.html はテンプレなので直接は読まない）
        win.loadFile(path.join(APP_ROOT, 'dist', 'index.html'));
    }
    if (process.env.NODE_ENV === 'development') {
        win.webContents.openDevTools();
    }

    return win;
}

// TTSのハンドラー
async function setupTTSHandler(mainWindow) {
    // 作業ディレクトリ関連（設定画面向け）
    ipcMain.handle('app-get-work-dir', async () => {
        return { workDir: getWorkDir() };
    });

    ipcMain.handle('app-open-work-dir', async () => {
        try {
            const dir = getWorkDir();
            if (!dir) {
                return { success: false, error: '作業ディレクトリが未設定です' };
            }
            const result = await shell.openPath(dir);
            if (result) {
                return { success: false, error: result };
            }
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('app-select-work-dir', async () => {
        try {
            const picked = await promptForWorkDir(mainWindow);
            if (!picked) {
                return { success: false, cancelled: true };
            }
            const applied = await applyWorkDir(picked);
            return { success: true, workDir: applied };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // セーブデータ管理
    ipcMain.handle('podcast-save-create', async (_, payload = {}) => {
        try {
            const workDir = getWorkDir();
            if (!workDir) {
                return { success: false, error: '作業ディレクトリが未設定です' };
            }
            const { record, fileName } = createSaveRecord({
                source: payload?.source || 'gui',
                request: payload?.request,
                workDir,
                result: payload?.result || { status: 'processing' }
            });
            const written = writeSaveRecord({ workDir, record, fileName });
            return {
                success: true,
                id: record.id,
                fileName: written.fileName,
                filePath: written.filePath,
                record
            };
        } catch (error) {
            console.error('セーブデータ作成エラー:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('podcast-save-list', async (_, payload = {}) => {
        try {
            const workDir = getWorkDir();
            if (!workDir) {
                return { success: false, error: '作業ディレクトリが未設定です', saves: [] };
            }
            const saves = listSaveRecords({
                workDir,
                limit: payload?.limit
            });
            return { success: true, saves };
        } catch (error) {
            console.error('セーブデータ一覧取得エラー:', error);
            return { success: false, error: error.message, saves: [] };
        }
    });

    ipcMain.handle('podcast-save-read', async (_, payload = {}) => {
        try {
            const workDir = getWorkDir();
            if (!workDir) {
                return { success: false, error: '作業ディレクトリが未設定です' };
            }

            const requestedRef = (typeof payload?.ref === 'string' && payload.ref.trim())
                ? payload.ref.trim()
                : '';

            const loaded = loadSaveRecord({
                workDir,
                id: payload?.id,
                fileName: payload?.fileName,
                filePath: requestedRef
            });
            return {
                success: true,
                record: loaded.record,
                filePath: loaded.filePath,
                fileName: loaded.fileName
            };
        } catch (error) {
            console.error('セーブデータ読込エラー:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('podcast-save-update-result', async (_, payload = {}) => {
        try {
            const workDir = getWorkDir();
            if (!workDir) {
                return { success: false, error: '作業ディレクトリが未設定です' };
            }

            const updated = updateSaveRecordResult({
                workDir,
                id: payload?.id,
                fileName: payload?.fileName,
                filePath: payload?.ref,
                result: payload?.result
            });

            return {
                success: true,
                record: updated.record,
                filePath: updated.filePath,
                fileName: updated.fileName
            };
        } catch (error) {
            console.error('セーブデータ更新エラー:', error);
            return { success: false, error: error.message };
        }
    });

    ttsService.on('audioPlayed', (data) => {
        mainWindow.webContents.send('tts-audio-played', data);
    });

    ttsService.on('progress', (data) => {
        mainWindow.webContents.send('tts-progress', data);
    });

    ttsService.on('processing-complete', (data) => {
        mainWindow.webContents.send('tts-processing-complete', data);
        const outputPath = data?.outputPath;
        if (typeof outputPath === 'string' && outputPath.trim()) {
            try {
                shell.showItemInFolder(outputPath);
            } catch (error) {
                console.error('Failed to reveal output video in Finder:', error);
            }
        }
    });

    ttsService.on('youtube-auth-complete', (data) => {
        mainWindow.webContents.send('tts-youtube-auth-complete', data);
    });


    // 音声制御ハンドラー
    ipcMain.handle('tts-pause-audio', async () => {
        try {
            await ttsService.pauseAudio();
            return { success: true };
        } catch (error) {
            console.error('Error pausing audio:', error);
            throw error;
        }
    });

    ipcMain.handle('tts-resume-audio', async () => {
        try {
            await ttsService.resumeAudio();
            return { success: true };
        } catch (error) {
            console.error('Error resuming audio:', error);
            throw error;
        }
    });

    ipcMain.handle('tts-stop-audio', async () => {
        try {
            await ttsService.stopAudio();
            return { success: true };
        } catch (error) {
            console.error('Error stopping audio:', error);
            throw error;
        }
    });

    ipcMain.handle('tts-change-speed', async (_, speed) => {
        try {
            await ttsService.changePlaybackSpeed(speed);
            return { success: true };
        } catch (error) {
            console.error('Error changing playback speed:', error);
            throw error;
        }
    });

    // 話者リスト取得ハンドラー
    ipcMain.handle('tts-get-speakers', async () => { console.log(ttsService); return await ttsService.getSpeakers() });

    ipcMain.handle('tts-get-english-speakers', async () => {
        return await ttsService.getEnglishSpeakers();
    });


    // 音声生成開始ハンドラー
    ipcMain.handle('tts-play-audio', async (_, datas, overlapDuration, playbackSpeed, autoGenerateVideo = false, options = {}) => {
        try {
            ttsService.playAudio(datas, overlapDuration, playbackSpeed, autoGenerateVideo, options);
            return { success: true };
        } catch (error) {
            console.error('Error starting audio generation:', error);
            throw error;
        }
    });

    // BGM 一覧を取得
    ipcMain.handle('tts-get-bgms', async () => {
        try {
            return ttsService.getAvailableBgms();
        } catch (error) {
            console.error('Error getting BGM list:', error);
            throw error;
        }
    });

    // イントロ背景動画 一覧を取得
    ipcMain.handle('tts-get-intro-bg-videos', async () => {
        try {
            return ttsService.getAvailableIntroBgVideos();
        } catch (error) {
            console.error('Error getting intro BG video list:', error);
            throw error;
        }
    });

    ipcMain.handle('tts-set-intro-bg-video', async (_, videoNameOrPath) => {
        try {
            const applied = ttsService.setIntroBgVideo(videoNameOrPath);
            return { success: true, path: applied };
        } catch (error) {
            console.error('Error setting intro background video:', error);
            throw error;
        }
    });

    ipcMain.handle('tts-read-json-file', async (_, targetPath) => {
        try {
            if (!targetPath) {
                return { success: false, error: 'ファイルパスが指定されていません' };
            }

            const baseDir = getWorkDir() || APP_ROOT;
            const normalizedTarget = (typeof targetPath === 'string') ? targetPath : String(targetPath);
            let resolvedPath = path.isAbsolute(normalizedTarget)
                ? targetPath
                : path.join(baseDir, normalizedTarget);

            if (!fs.existsSync(resolvedPath)) {
                return { success: false, error: 'ファイルが存在しません' };
            }

            const content = await fsPromises.readFile(resolvedPath, 'utf8');
            const parsed = JSON.parse(content);
            return { success: true, data: parsed };
        } catch (error) {
            console.error('JSONファイルの読み込みに失敗しました:', error);
            return { success: false, error: error.message };
        }
    });

    // BGM を設定
    ipcMain.handle('tts-set-bgm', async (_, bgmPath) => {
        try {
            const applied = ttsService.setBgmPath(bgmPath);
            return { success: true, path: applied };
        } catch (error) {
            console.error('Error setting BGM:', error);
            throw error;
        }
    });

    ipcMain.handle('tts-set-bgm-volume', async (_, volume) => {
        try {
            const appliedVolume = ttsService.setBgmVolume(volume);
            return { success: true, volume: appliedVolume };
        } catch (error) {
            console.error('Error setting BGM volume:', error);
            throw error;
        }
    });

    // 字幕（drawtext）表示のON/OFF
    ipcMain.handle('tts-set-captions-enabled', async (_, enabled) => {
        try {
            const applied = ttsService.setCaptionsEnabled(enabled);
            return { success: true, captionsEnabled: applied };
        } catch (error) {
            console.error('Error setting captions enabled:', error);
            throw error;
        }
    });

    ipcMain.handle('tts-next-audio', async () => {
        try {
            await ttsService.nextAudio();
            return { success: true };
        } catch (error) {
            console.error('Error going to next audio:', error);
            throw error;
        }
    });

    ipcMain.handle('tts-prev-audio', async () => {
        try {
            await ttsService.prevAudio();
            return { success: true };
        } catch (error) {
            console.error('Error going to previous audio:', error);
            throw error;
        }
    });

    ipcMain.handle('tts-restart-audio', async () => {
        try {
            await ttsService.restartAudio();
            return { success: true };
        } catch (error) {
            console.error('Error restarting audio:', error);
            throw error;
        }
    });

    ipcMain.handle('tts-make-video', async (_) => {
        try {
            const videoPath = await ttsService.makeVideo(null);
            return videoPath;
        } catch (error) {
            console.error('Error creating video:', error);
            throw error;
        }
    });

    ipcMain.handle('tts-set-youtube-info', async (_, youtubeInfo) => {
        try {
            ttsService.setYoutubeInfo(youtubeInfo);
            return { success: true };
        } catch (error) {
            console.error('Error setting youtube info:', error);
            throw error;
        }
    });

    ipcMain.handle('tts-set-auto-generate-video', async (_, value) => {
        try {
            ttsService.setAutoGenerateVideo(value);
            return { success: true };
        } catch (error) {
            console.error('Error setting auto generate video:', error);
            throw error;
        }
    });

    // クリップボードから画像を保存するハンドラー
    ipcMain.handle('tts-save-clipboard-image', async () => {
        try {
            const image = clipboard.readImage();
            if (image.isEmpty()) {
                throw new Error('クリップボードに画像がありません');
            }

            // PNGとしてバッファに変換
            const buffer = image.toPNG();

            // 画像を保存
            const imagePath = await ttsService.saveBackgroundImage(buffer);
            return imagePath;
        } catch (error) {
            console.error('クリップボードからの画像保存に失敗:', error);
            throw error;
        }
    });

    ipcMain.handle('tts-save-background-image', async (_, imageBlob) => {
        try {
            const imagePath = await ttsService.saveBackgroundImage(imageBlob);
            return imagePath;
        } catch (error) {
            console.error('背景画像の保存に失敗:', error);
            throw error;
        }
    });

    ipcMain.handle('tts-create-background-image', async (_, text) => {
        try {
            await ttsService.createBackgroundImage(text);
        } catch (error) {
            console.error('背景画像の作成に失敗:', error);
            throw error;
        }
    });

    // 現在の背景画像のパスを取得するハンドラー
    ipcMain.handle('tts-get-current-background', async () => {
        const exists = fs.existsSync(TEMP_BG_PATH);
        return exists ? TEMP_BG_PATH : null;
    });

    ipcMain.handle('tts-upload-youtube', async () => {
        try {
            const result = await ttsService.uploadToYoutube();
            return { success: result };
        } catch (error) {
            console.error('Error uploading to YouTube:', error);
            throw error;
        }
    });

    ipcMain.handle('tts-set-auto-upload-youtube', async (_, value) => {
        try {
            ttsService.setAutoUploadToYoutube(value);
            return { success: true };
        } catch (error) {
            console.error('Error setting auto upload to youtube:', error);
            throw error;
        }
    });

    // スピーカー動画プレフィックス設定ハンドラー
    ipcMain.handle('tts-set-speaker-video-prefix', async (_, prefix) => {
        try {
            ttsService.setSpeakerVideoPrefix(prefix);
            return { success: true };
        } catch (error) {
            console.error('Error setting speaker video prefix:', error);
            throw error;
        }
    });

    // YouTube認証関連のハンドラーを追加
    ipcMain.handle('tts-has-youtube-credentials', async () => {
        try {
            const hasCredentials = ttsService.hasYoutubeCredentials();
            return { hasCredentials };
        } catch (error) {
            console.error('Error checking YouTube credentials:', error);
            return { hasCredentials: false, error: error.message };
        }
    });

    ipcMain.handle('tts-get-youtube-token-files', async () => {
        try {
            const tokens = ttsService.getAvailableYoutubeTokenFiles();
            return { tokens };
        } catch (error) {
            console.error('Error getting YouTube token files:', error);
            return { tokens: [], error: error.message };
        }
    });

    ipcMain.handle('tts-check-youtube-auth', async () => {
        try {
            const isAuthenticated = await ttsService.checkYoutubeAuth();
            return { isAuthenticated };
        } catch (error) {
            console.error('Error checking YouTube auth:', error);
            throw error;
        }
    });

    ipcMain.handle('tts-get-youtube-auth-url', async () => {
        try {
            const { authUrl, authState } = await ttsService.getYoutubeAuthUrl();
            return { authUrl, authState };
        } catch (error) {
            console.error('Error getting YouTube auth URL:', error);
            throw error;
        }
    });

    ipcMain.handle('tts-cancel-youtube-auth', async () => {
        try {
            return await ttsService.cancelYoutubeAuth();
        } catch (error) {
            console.error('Error cancelling YouTube auth:', error);
            throw error;
        }
    });

    ipcMain.handle('tts-submit-youtube-auth-code', async (_, code) => {
        console.log('YouTube認証コードを送信');
        return await ttsService.submitYoutubeAuthCode(code);
    });

    ipcMain.handle('tts-set-youtube-token-file', async (_, tokenFile) => {
        try {
            ttsService.setYoutubeTokenFile(tokenFile);
            return { success: true };
        } catch (error) {
            console.error('Error setting YouTube token file:', error);
            throw error;
        }
    });

    // ローカル画像をBase64に変換する
    ipcMain.handle('tts-get-local-image-as-base64', async (_, filePath) => {
        console.log('ローカル画像をBase64に変換:', filePath);
        return await ttsService.getLocalImageAsBase64(filePath);
    });

    // 動画ファイルからサムネイルを生成する
    ipcMain.handle('tts-generate-thumbnail-from-video', async (_, videoPath) => {
        console.log('動画ファイルからサムネイルを生成:', videoPath);
        return await ttsService.generateThumbnailFromVideo(videoPath);
    });

    // クリップボードからファイルパスを取得する
    ipcMain.handle('tts-get-clipboard-file-path', () => {
        console.log('クリップボードからファイルパスを取得');
        try {
            let filePath = '';

            // OSによって処理を分ける
            if (process.platform === 'darwin') { // macOS
                // 1. まずpublic.file-urlからフルパスURLの取得を試みる
                const fileUrl = clipboard.read('public.file-url');
                console.log('Mac clipboard file URL:', fileUrl);

                if (fileUrl) {
                    // file:// 形式のURLをデコードして通常のパスにする
                    filePath = decodeURIComponent(fileUrl).replace('file://', '');
                } else {
                    // 2. それが失敗したら、通常のテキストからファイル名の取得を試みる
                    const plainText = clipboard.readText();
                    console.log('Mac clipboard plain text:', plainText);

                    // ファイル名だけの場合は、最後の実行ディレクトリから探す
                    // ここではテキストが拡張子を持つファイル名である場合のみ対応
                    if (plainText && plainText.includes('.') && !plainText.includes('/') && !plainText.includes('\\')) {
                        // これはファイル名だけの可能性が高い
                        // フロントエンドからファイル名だけでなく、探索するディレクトリパスも送るとより確実
                        const possibleExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.mp4', '.mov', '.avi'];
                        if (possibleExtensions.some(ext => plainText.toLowerCase().endsWith(ext))) {
                            // 現在のディレクトリまたは指定されたディレクトリから探す実装を追加できる
                            // ここでは単純にファイル名だけを返す
                            filePath = plainText;
                        }
                    }
                }
            } else if (process.platform === 'win32') { // Windows
                const rawFilePath = clipboard.readBuffer('FileNameW');
                if (rawFilePath) {
                    // Windows では UCS2 エンコードで nullバイト区切りのパス
                    filePath = rawFilePath.toString('ucs2').replace(/\\/g, '/').replace(/\0/g, '');
                }
            } else { // Linux その他
                // Linux 向けの実装がまだの場合は空文字を返す
                filePath = '';
            }

            console.log('取得したファイルパス:', filePath);

            if (!filePath) {
                return { success: false, error: 'クリップボードにファイルパスがありません' };
            }

            return { success: true, filePath: filePath };
        } catch (error) {
            console.error('クリップボードからファイルパス取得エラー:', error);
            return { success: false, error: error.message };
        }
    });

    // ドロップされたファイルを一時保存する
    ipcMain.handle('tts-save-uploaded-file', async (_, fileData) => {
        try {
            console.log('ドロップされたファイルを保存:', fileData.name);


            // 一時ディレクトリの確認・作成
            if (!fs.existsSync(TEMP_DIR)) {
                fs.mkdirSync(TEMP_DIR, { recursive: true });
            }

            // 一意のファイル名を生成
            const fileExt = path.extname(fileData.name);
            const fileName = `${fileData.name}-${fileData.buffer.length}-${fileExt}`;
            const filePath = path.join(TEMP_DIR, fileName);

            // ファイルを保存
            if (fs.existsSync(filePath)) {
                console.log('ファイルがすでに存在します:', filePath);
            } else {
                await fsPromises.writeFile(filePath, Buffer.from(fileData.buffer));
            }

            return {
                success: true,
                filePath: filePath,
                fileName: fileName,
                originalName: fileData.name
            };
        } catch (error) {
            console.error('ファイル保存エラー:', error);
            return { success: false, error: error.message };
        }
    });
}

async function main() {
    const mainWindow = await createWindow();
    setupTTSHandler(mainWindow);
}

app.whenReady().then(async () => {
    if (process.platform === 'darwin' && app.dock) {
        try {
            const icon = nativeImage.createFromPath(APP_ICON_PATH);
            if (!icon.isEmpty()) {
                app.dock.setIcon(icon);
            }
        } catch (error) {
            console.error('Failed to set Dock icon:', error);
        }
    }
    if (IS_PODCAST_CLI) {
        const resolvedWorkDir = (typeof CLI_WORK_DIR === 'string' && CLI_WORK_DIR.trim())
            ? CLI_WORK_DIR.trim()
            : (typeof process.env.PODCAST_CREATOR_WORKDIR === 'string' ? process.env.PODCAST_CREATOR_WORKDIR.trim() : '');

        if (!resolvedWorkDir) {
            console.error('Missing workdir. Set PODCAST_CREATOR_WORKDIR or pass --workdir.');
            app.exit(1);
            return;
        }

        WORK_DIR = resolvedWorkDir;
        process.env.PODCAST_CREATOR_WORKDIR = resolvedWorkDir;

        ttsService = require('./tts-service');
        if (ttsService && typeof ttsService.setWorkDir === 'function') {
            try {
                ttsService.setWorkDir(resolvedWorkDir);
            } catch (error) {
                console.error('TTSサービスの作業ディレクトリ設定に失敗しました:', error);
            }
        }

        try {
            const { runPodcastRunner } = require('./cli/podcast-runner');
            const exitCode = await runPodcastRunner({
                podcastPath: CLI_PODCAST_PATH,
                resumePath: CLI_RESUME_PATH,
                workDir: resolvedWorkDir,
                ttsService
            });
            app.exit(exitCode);
        } catch (error) {
            console.error('Podcast CLI failed:', error?.message || error);
            app.exit(1);
        }
        return;
    }

    await ensureWorkDir();
    // 作業ディレクトリ確定後に読み込む（配布時に .app 内へ書き込みしないため）
    ttsService = require('./tts-service');
    if (ttsService && typeof ttsService.setWorkDir === 'function') {
        try {
            ttsService.setWorkDir(getWorkDir());
        } catch (error) {
            console.error('TTSサービスの作業ディレクトリ設定に失敗しました:', error);
        }
    }
    await main();
});

app.on('window-all-closed', () => {
    if (IS_PODCAST_CLI) return;
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', async () => {
    if (IS_PODCAST_CLI) return;
    if (BrowserWindow.getAllWindows().length === 0) {
        await createWindow();
    }
});
