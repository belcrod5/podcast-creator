const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { exec, spawn, spawnSync } = require('child_process');
const os = require('os');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const player = require('play-sound')(opts = {})
const ffmpeg = require('fluent-ffmpeg');
const YouTubeUploader = require('./tts/youtube');
const http = require('http');
const sizeOf = require('image-size');

const AIVIS_URL = 'http://localhost:10101';
const TEMP_DIR = path.join(os.tmpdir(), 'aivis-audio');
const AIVIS_APP_PATH = '/Applications/AivisSpeech.app';

// 既存の定数に追加
const TEMP_BG_PATH = path.join(TEMP_DIR, 'current-bg.png');

// 一時ディレクトリの作成
if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// アプリケーションのルートパスを取得（electron/ 配下からプロジェクトルートへ）
const APP_ROOT = path.resolve(__dirname, '..');

// 作業ディレクトリ（ユーザーが編集できる領域）
// - main.js から環境変数 PODCAST_CREATOR_WORKDIR が渡される想定
const normalizeWorkDir = (value) => (
    typeof value === 'string' && value.trim() ? value.trim() : null
);
let WORK_DIR = normalizeWorkDir(process.env.PODCAST_CREATOR_WORKDIR) || APP_ROOT;

const getWorkDir = () => WORK_DIR;
const setWorkDirRoot = (value) => {
    const normalized = normalizeWorkDir(value);
    if (normalized) WORK_DIR = normalized;
    return WORK_DIR;
};

// 素材ルートは常に作業ディレクトリ直下に固定する。
const getAssetsPath = () => getWorkDir();

// YouTube設定は作業DIR/config/youtube に集約（local は廃止）
const getYoutubeConfigDir = () => path.join(getWorkDir(), 'config', 'youtube');
const YOUTUBE_CREDENTIALS_FILE = 'credentials.json';
const getSpeakerVideosDir = () => path.join(getAssetsPath(), 'speaker-videos');

const ensureDirSync = (targetDir) => {
    try {
        if (!targetDir) return;
        if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir, { recursive: true });
        }
    } catch (error) {
        console.warn('ディレクトリ作成に失敗しました:', targetDir, error);
    }
};

const TOOLS_PATH = path.join(APP_ROOT, 'tools');
const EN_TTS_ROOT = path.join(TOOLS_PATH, 'tts-en');
const EN_TTS_SCRIPT_PATH = path.join(EN_TTS_ROOT, 'scripts', 'quick_tts.py');
const EN_TTS_PYTHON = process.platform === 'win32'
    ? path.join(EN_TTS_ROOT, '.venv', 'Scripts', 'python.exe')
    : path.join(EN_TTS_ROOT, '.venv', 'bin', 'python');

const resolveProjectPath = (value) => {
    if (!value || typeof value !== 'string') return value;
    // URL / custom scheme はそのまま（ファイルパス解決の対象外）
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value) || value.startsWith('local-media:') || value.startsWith('local-image:')) {
        return value;
    }
    if (path.isAbsolute(value)) return value;
    return path.join(APP_ROOT, value);
};

const getFontPath = (fontName) => {
    // 指定フォント（assets/fonts）を優先し、存在しない場合のみ system フォントへフォールバック
    if (fontName && typeof fontName === 'string') {
        const safeName = path.basename(fontName);
        const candidate = path.join(getAssetsPath(), 'fonts', safeName);
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }

    // Fallback: 現在の処理（system フォント）
    if (process.platform === 'darwin') {
        return '/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc';
    }
    if (process.platform === 'win32') {
        return 'C:\\Windows\\Fonts\\msgothic.ttc';
    }
    return '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
};

const isExecutableFile = (filePath) => {
    try {
        return !!filePath && fs.existsSync(filePath) && fs.statSync(filePath).isFile();
    } catch (_) {
        return false;
    }
};

const findBinaryOnPath = (binaryName) => {
    const pathEnv = process.env.PATH || '';
    const entries = pathEnv.split(path.delimiter).filter(Boolean);
    for (const entry of entries) {
        const candidate = path.join(entry, binaryName);
        if (isExecutableFile(candidate)) return candidate;
    }
    return null;
};

const supportsLavfiCache = new Map();
const supportsLavfi = (binaryPath) => {
    if (supportsLavfiCache.has(binaryPath)) {
        return supportsLavfiCache.get(binaryPath);
    }
    let supported = false;
    try {
        const result = spawnSync(binaryPath, ['-hide_banner', '-formats'], { encoding: 'utf8' });
        const output = `${result.stdout || ''}\n${result.stderr || ''}`;
        supported = result.status === 0 && output.includes('lavfi');
    } catch (_) {
        supported = false;
    }
    supportsLavfiCache.set(binaryPath, supported);
    return supported;
};

const resolveBinaryPath = ({ binaryName, envVar, candidates, validate }) => {
    const preferred = [];
    const fromEnv = process.env[envVar];
    if (fromEnv) preferred.push(fromEnv);
    preferred.push(...candidates);
    const fromPath = findBinaryOnPath(binaryName);
    if (fromPath) preferred.push(fromPath);
    preferred.push(binaryName);

    const seen = new Set();
    let fallback = null;
    for (const candidate of preferred) {
        if (!candidate || seen.has(candidate)) continue;
        seen.add(candidate);
        const isPath = path.isAbsolute(candidate) || candidate.includes(path.sep);
        if (isPath && !isExecutableFile(candidate)) continue;
        if (!fallback) fallback = candidate;
        if (!validate || validate(candidate)) return candidate;
    }
    return fallback || binaryName;
};

// ImageMagick の実行パス（Homebrew 由来の PATH が Electron に引き継がれないケース対策）
const MAGICK_BIN = resolveBinaryPath({
    binaryName: process.platform === 'win32' ? 'magick.exe' : 'magick',
    envVar: 'MAGICK_PATH',
    candidates: [
        '/opt/homebrew/bin/magick', // Apple Silicon Homebrew
        '/usr/local/bin/magick'     // Intel Homebrew
    ]
});

// FFmpeg / FFprobe の実行パス（Homebrew 由来の PATH が Electron に引き継がれないケース対策）
const FFMPEG_BIN = resolveBinaryPath({
    binaryName: process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg',
    envVar: 'FFMPEG_PATH',
    candidates: [
        '/opt/homebrew/bin/ffmpeg', // Apple Silicon Homebrew
        '/usr/local/bin/ffmpeg'     // Intel Homebrew
    ],
    validate: supportsLavfi
});

const FFPROBE_BIN = resolveBinaryPath({
    binaryName: process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe',
    envVar: 'FFPROBE_PATH',
    candidates: [
        '/opt/homebrew/bin/ffprobe', // Apple Silicon Homebrew
        '/usr/local/bin/ffprobe'     // Intel Homebrew
    ]
});

ffmpeg.setFfmpegPath(FFMPEG_BIN);
ffmpeg.setFfprobePath(FFPROBE_BIN);

const patchFluentFfmpegLavfi = () => {
    if (ffmpeg.prototype.__lavfiPatched) return;
    ffmpeg.prototype.__lavfiPatched = true;
    const originalAvailableFormats = ffmpeg.prototype.availableFormats;
    ffmpeg.prototype.availableFormats = function (callback) {
        return originalAvailableFormats.call(this, (err, formats) => {
            if (!err && formats && !formats.lavfi && supportsLavfi(FFMPEG_BIN)) {
                formats.lavfi = {
                    description: 'Libavfilter virtual input device',
                    canDemux: true,
                    canMux: false
                };
            }
            callback(err, formats);
        });
    };
    ffmpeg.prototype.getAvailableFormats = ffmpeg.prototype.availableFormats;
};

patchFluentFfmpegLavfi();

if (!supportsLavfi(FFMPEG_BIN)) {
    console.warn('[WARN] FFmpegにlavfiが見つかりませんでした。Homebrew版のffmpegが必要です。');
    console.warn(`[WARN] 使用中のffmpeg: ${FFMPEG_BIN}`);
    console.warn('[WARN] 対処: brew install ffmpeg / brew reinstall ffmpeg');
}
const LANGUAGE_CODES = {
    JAPANESE: 'ja',
    ENGLISH: 'en'
};
const normalizeLanguage = (value) => (
    typeof value === 'string' && value.toLowerCase() === LANGUAGE_CODES.ENGLISH
        ? LANGUAGE_CODES.ENGLISH
        : LANGUAGE_CODES.JAPANESE
);


// ※作業ディレクトリ配下のフォルダは「勝手に作らない」方針のため、
// 必要なタイミング（保存時など）にだけ作成する。

// 動画連結時に一度に処理する最大クリップ数（変更する場合はここを修正）
const MAX_CLIPS_PER_CONCAT = 500;

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.avi', '.mkv', '.webm']);
const ECHO_DELAY = 250;
const YOUTUBE_AUTH_TIMEOUT_MS = 5 * 60 * 1000;

// 字幕（drawtext）の最大横幅（画面幅に対する比率）
const SUBTITLE_MAX_WIDTH_RATIO = 0.8;

// 字幕の折り返し推定の言語別補正
// - 日本語は全角が多く「1文字 ≒ fontSize」になりやすいので補正なし(1.0)
// - 英語は半角が多く1文字の平均幅が細いので、同じ文字数だと表示幅が狭く見える
//   → 英語だけ「1行あたりの文字数」を増やす係数を掛けて80%幅に近づける
//   ※まだ狭い/広い場合は、まずこの係数を調整してください
const SUBTITLE_WRAP_CHARS_MULTIPLIER_BY_LANGUAGE = {
    [LANGUAGE_CODES.JAPANESE]: 1.0,
    [LANGUAGE_CODES.ENGLISH]: 1.7
};

const SUBTITLE_WRAP_MIN_CHARS_PER_LINE = 10;
const SUBTITLE_WRAP_MAX_CHARS_PER_LINE = 160;

// CallOut（上部テロップ）の折り返し最小文字数
// - Short動画ではフォントが大きく、字幕用(10)だと横にはみ出しやすいため別で管理する
const CALLOUT_WRAP_MIN_CHARS_PER_LINE = 7;

// CallOut（上部テロップ）の余白(padding)を言語別に調整する（px）
// - layout側の callout.marginX/marginY に「加算」されます
// - 日本語だけ少し余白を増やして、はみ出し・詰まりを抑えます（必要ならここを調整）
const CALLOUT_PADDING_EXTRA_PX_BY_LANGUAGE = {
    [LANGUAGE_CODES.JAPANESE]: { marginX: 5, marginY: 0 },
    [LANGUAGE_CODES.ENGLISH]: { marginX: 0, marginY: 0 }
};

// 動画の出力形式（横長/ショート）
const VIDEO_FORMATS = {
    LANDSCAPE: 'landscape',
    SHORT: 'short'
};

const normalizeVideoFormat = (value) => (
    typeof value === 'string' && value.toLowerCase() === VIDEO_FORMATS.SHORT
        ? VIDEO_FORMATS.SHORT
        : VIDEO_FORMATS.LANDSCAPE
);

// [Short動画] PiP(丸抜き)の調整用定数
// - ここを変更すると、ショート動画(1080x1920)のPiPの「大きさ」と「下からの位置」を調整できます。
// - 位置は「下中央」に固定し、余白とサイズのみ調整できるようにしています。
const SHORT_PIP_DIAMETER_PX = 1100;
const SHORT_PIP_BOTTOM_MARGIN_PX = 400;

// 動画レイアウト定義（解像度・字幕・CallOut・PiP）
// - ここを編集すると、ショート/横長の見た目をまとめて調整できます。
const VIDEO_LAYOUTS = {
    [VIDEO_FORMATS.LANDSCAPE]: {
        width: 1920,
        height: 1080,
        subtitles: {
            maxWidthRatio: SUBTITLE_MAX_WIDTH_RATIO,
            fontSize: 48,
            boxHeight: 135,
            bottomMargin: 80
        },
        callout: {
            maxWidthRatio: 0.9,
            fontSize: 160,
            marginX: 60,
            marginY: 70
        },
        // 横長は従来通り右下に配置（既存挙動維持）
        pip: {
            diameter: 675,
            overlayX: '1500',
            overlayY: '650'
        }
    },
    [VIDEO_FORMATS.SHORT]: {
        width: 1080,
        height: 1920,
        subtitles: {
            maxWidthRatio: 0.92,
            fontSize: 48,
            boxHeight: 150,
            bottomMargin: 140
        },
        callout: {
            maxWidthRatio: 0.92,
            fontSize: 220,
            marginX: 40,
            marginY: 90
        },
        // ショートは下中央に配置（サイズ/下余白は上の定数で調整）
        pip: {
            diameter: SHORT_PIP_DIAMETER_PX,
            overlayX: '(main_w-overlay_w)/2',
            overlayY: `(main_h-overlay_h)-${SHORT_PIP_BOTTOM_MARGIN_PX}`
        }
    }
};

function getVideoLayout(videoFormat) {
    const normalized = normalizeVideoFormat(videoFormat);
    return VIDEO_LAYOUTS[normalized] || VIDEO_LAYOUTS[VIDEO_FORMATS.LANDSCAPE];
}

function wrapTextForDrawText(text, maxCharsPerLine = 15, language = LANGUAGE_CODES.JAPANESE) {
    const normalizedLanguage = normalizeLanguage(language);
    const lines = String(text ?? '').split(/\r?\n/);
    const wrappedLines = [];

    // 英語は単語途中で切ると「tha t」のように見えてしまうため、スペース区切りで折り返す
    if (normalizedLanguage === LANGUAGE_CODES.ENGLISH) {
        lines.forEach((line) => {
            const trimmed = String(line ?? '').trim();
            if (!trimmed) {
                wrappedLines.push('');
                return;
            }

            const words = trimmed.split(' ');
            let current = '';
            let currentLen = 0;

            const flush = () => {
                if (currentLen > 0) {
                    wrappedLines.push(current);
                    current = '';
                    currentLen = 0;
                }
            };

            words.forEach((word) => {
                if (!word) {
                    return;
                }

                const wordChars = Array.from(word);
                const wordLen = wordChars.length;

                // 1単語が長すぎる場合は安全のため分割（通常の英単語ではほぼ起きない想定）
                const pushLongWord = () => {
                    for (let i = 0; i < wordChars.length; i += maxCharsPerLine) {
                        wrappedLines.push(wordChars.slice(i, i + maxCharsPerLine).join(''));
                    }
                };

                if (currentLen === 0) {
                    if (wordLen <= maxCharsPerLine) {
                        current = word;
                        currentLen = wordLen;
                    } else {
                        pushLongWord();
                    }
                    return;
                }

                // 先頭以外はスペース1文字分を加算
                if (currentLen + 1 + wordLen <= maxCharsPerLine) {
                    current += ` ${word}`;
                    currentLen += 1 + wordLen;
                    return;
                }

                flush();

                if (wordLen <= maxCharsPerLine) {
                    current = word;
                    currentLen = wordLen;
                } else {
                    pushLongWord();
                }
            });

            flush();
        });

        return wrappedLines.join('\n');
    }

    // 日本語（スペースが少ない）向け：文字数で均等に折り返す
    lines.forEach((line) => {
        let buffer = '';
        let count = 0;
        const chars = Array.from(line);

        chars.forEach((char) => {
            buffer += char;
            count += 1;
            if (count >= maxCharsPerLine) {
                wrappedLines.push(buffer);
                buffer = '';
                count = 0;
            }
        });

        if (buffer.length > 0) {
            wrappedLines.push(buffer);
        }

        if (chars.length === 0) {
            wrappedLines.push('');
        }
    });

    return wrappedLines.join('\n');
}

function formatSrtTimestamp(seconds) {
    const sec = (typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0) ? seconds : 0;
    const totalMs = Math.max(0, Math.round(sec * 1000));
    const ms = totalMs % 1000;
    const totalSeconds = Math.floor(totalMs / 1000);
    const s = totalSeconds % 60;
    const totalMinutes = Math.floor(totalSeconds / 60);
    const m = totalMinutes % 60;
    const h = Math.floor(totalMinutes / 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

function buildSrtContent(cues) {
    const lines = [];
    let index = 1;
    for (const cue of cues || []) {
        const start = cue?.start;
        const end = cue?.end;
        const text = typeof cue?.text === 'string' ? cue.text : String(cue?.text ?? '');
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
        const trimmed = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
        if (!trimmed) continue;
        lines.push(String(index++));
        lines.push(`${formatSrtTimestamp(start)} --> ${formatSrtTimestamp(end)}`);
        lines.push(trimmed);
        lines.push('');
    }
    return lines.join('\n');
}
// パフォーマンスログ用のユーティリティを追加
const performanceLogger = {
    logs: [],
    logFile: path.join(os.tmpdir(), 'aivis-audio', 'performance-logs.json'),

    // ログエントリを追加
    addLog(operation, details = {}) {
        const entry = {
            operation,
            timestamp: new Date().toISOString(),
            ...details
        };
        this.logs.push(entry);
        console.log(`[PERF] ${operation}: ${JSON.stringify(details)}`);
        return entry;
    },

    // 処理時間を計測してログに追加
    startTimer(operation) {
        const startTime = Date.now();
        return {
            end: (details = {}) => {
                const endTime = Date.now();
                const duration = endTime - startTime;
                this.addLog(operation, {
                    ...details,
                    duration_ms: duration,
                    duration_readable: this.formatDuration(duration)
                });
                return duration;
            }
        };
    },

    // ミリ秒を読みやすい形式に変換
    formatDuration(ms) {
        if (ms < 1000) return `${ms}ms`;

        const seconds = Math.floor(ms / 1000) % 60;
        const minutes = Math.floor(ms / (1000 * 60)) % 60;
        const hours = Math.floor(ms / (1000 * 60 * 60));

        const parts = [];
        if (hours > 0) parts.push(`${hours}h`);
        if (minutes > 0) parts.push(`${minutes}m`);
        if (seconds > 0) parts.push(`${seconds}s`);

        return parts.join(' ');
    },

    // すべてのログを一時ファイルに保存
    saveLogs(additionalInfo = {}) {
        try {
            // 保存先ディレクトリが存在しない場合は作成
            const dir = path.dirname(this.logFile);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }

            // 既存のログとマージ
            let existingLogs = [];
            if (fs.existsSync(this.logFile)) {
                try {
                    existingLogs = JSON.parse(fs.readFileSync(this.logFile, 'utf8'));
                } catch (e) {
                    console.error('既存のログファイルの読み込みに失敗しました:', e);
                }
            }

            // 現在の日時を追加
            const logEntry = {
                logs: this.logs,
                saved_at: new Date().toISOString(),
                ...additionalInfo
            };

            // 新しいログエントリを追加
            existingLogs.push(logEntry);

            // ファイルに書き込み
            fs.writeFileSync(this.logFile, JSON.stringify(existingLogs, null, 2));
            console.log(`パフォーマンスログをファイルに保存しました: ${this.logFile}`);

            // ログをクリア
            this.logs = [];

            return this.logFile;
        } catch (error) {
            console.error('パフォーマンスログの保存に失敗しました:', error);
            return null;
        }
    }
};

// 動画ファイルの長さを取得するメソッド
async function getVideoDuration(filePath) {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(filePath, (err, metadata) => {
            if (err) {
                console.error(`FFprobe エラー (動画長さ取得): ${err.message}`);
                reject(err);
                return;
            }

            if (metadata && metadata.format && metadata.format.duration) {
                resolve(parseFloat(metadata.format.duration));
            } else {
                reject(new Error('動画ファイルの長さを取得できませんでした'));
            }
        });
    });
}

function parseTimecodeToSeconds(value) {
    if (typeof value === 'number' && isFinite(value) && value >= 0) {
        return value;
    }

    if (typeof value !== 'string') {
        return null;
    }

    const raw = value.trim();
    if (!raw) {
        return null;
    }

    const parts = raw.split(':').map(part => part.trim()).filter(Boolean);
    if (parts.length === 0) {
        return null;
    }

    let multiplier = 1;
    let total = 0;
    for (let i = parts.length - 1; i >= 0; i--) {
        const num = Number(parts[i]);
        if (!Number.isFinite(num) || num < 0) {
            return null;
        }
        total += num * multiplier;
        multiplier *= 60;
    }
    return total;
}

async function hasAudioStream(filePath) {
    return new Promise((resolve) => {
        ffmpeg.ffprobe(filePath, (err, metadata) => {
            if (err) {
                resolve(false);
                return;
            }
            const hasAudio = Array.isArray(metadata?.streams)
                && metadata.streams.some(stream => stream.codec_type === 'audio');
            resolve(hasAudio);
        });
    });
}

class TTsServer {

    static isServerStarting = false;

    /**
     * AIVISサーバーが利用可能かチェック
     * @returns {Promise<boolean>}
     */
    static async isServerAvailable() {
        try {
            await axios.get(`${AIVIS_URL}/version`);
            return true;
        } catch (error) {
            return false;
        }
    }
    /**
     * AIVISサーバーを起動
     * @returns {Promise<void>}
     */
    static async startServer() {
        if (TTsServer.isServerStarting) return;

        TTsServer.isServerStarting = true;
        return new Promise((resolve, reject) => {
            console.log('AIVISサーバーを起動中...');
            exec(`open "${AIVIS_APP_PATH}"`, async (error) => {
                if (error) {
                    TTsServer.isServerStarting = false;
                    console.error('AIVISサーバーの起動に失敗しました:', error);
                    reject(error);
                    return;
                }

                let attempts = 0;
                const maxAttempts = 30; // 30秒待機
                const checkServer = async () => {
                    if (await this.isServerAvailable()) {
                        console.log('AIVISサーバーが起動しました');
                        TTsServer.isServerStarting = false;
                        resolve();
                    } else if (attempts < maxAttempts) {
                        attempts++;
                        setTimeout(checkServer, 1000);
                    } else {
                        TTsServer.isServerStarting = false;
                        reject(new Error('AIVISサーバーの起動がタイムアウトしました'));
                    }
                };
                setTimeout(checkServer, 2000);
            });
        });
    }

    static async withServerCheck(apiCall) {
        try {
            return await apiCall();
        } catch (error) {
            if (!await TTsServer.isServerAvailable()) {
                try {
                    await TTsServer.startServer();
                    return await apiCall();
                } catch (startError) {
                    throw new Error(`AIVISサーバーの起動に失敗しました: ${startError.message}`);
                }
            }
            throw error;
        }
    }

    static async getSpeakers() {

        return TTsServer.withServerCheck(async () => {
            try {
                const response = await axios.get(`${AIVIS_URL}/speakers`);
                return response.data;
            } catch (error) {
                console.error('話者リストの取得に失敗しました:', error);
                throw error;
            }
        });
    }

    static async getEnglishSpeakers() {
        return new Promise((resolve, reject) => {
            if (!fs.existsSync(EN_TTS_PYTHON) || !fs.existsSync(EN_TTS_SCRIPT_PATH)) {
                // 英語TTSが未セットアップでもアプリ全体は動作できるようにする。
                // UI起動時に話者一覧を取りに行くため、ここではエラーにせず「空配列」で返す。
                console.warn(
                    `English TTS is not set up. Skipping english speakers list. ` +
                    `Expected python at ${EN_TTS_PYTHON} and script at ${EN_TTS_SCRIPT_PATH}`
                );
                resolve([]);
                return;
            }

            const command = `"${EN_TTS_PYTHON}" "${EN_TTS_SCRIPT_PATH}" --list`;
            exec(command, { shell: '/bin/zsh' }, (error, stdout, stderr) => {
                if (error) {
                    console.error('Failed to get English speakers:', error);
                    // 一覧取得失敗は致命ではないため、空配列で返す
                    resolve([]);
                    return;
                }
                const lines = stdout.split('\n');
                const speakers = [];
                for (const line of lines) {
                    const match = line.match(/^\s*-\s*([^:]+):/);
                    if (match) {
                        speakers.push(match[1].trim());
                    }
                }
                resolve(speakers);
            });
        });
    }
}

class TTSServiceMain extends EventEmitter {

    currentInstance = null;
    youtubeUploader = null;
    youtubeAuthServer = null;
    youtubeAuthState = null;
    youtubeAuthRedirectUri = null;
    youtubeAuthTimeout = null;
    /**
     * 動画ファイル名の接頭辞（例: _v なら "{speakerId}_v.mp4"）
     * UI から動的に変更できるようにプロパティとして保持する。
     * デフォルトは空文字。
     */
    speakerVideoPrefix = '';
    /**
     * 現在選択されているBGMファイルパス
     */
    currentBgmPath = null;
    /**
     * 現在のBGM音量 (0.0 - 1.0)
     */
    currentBgmVolume = 0.2;
    /**
     * イントロで使用する背景動画パス
     */
    currentIntroBgVideo = null;
    /**
     * 字幕（drawtext）の表示ON/OFF
     */
    captionsEnabled = true;

    constructor() {
        super();
        this.currentInstance = null;
        this.youtubeUploader = null;
        this.instances = []; // instances配列を初期化
        this.youtubeTokenFile = 'youtube-token.json';
    }

    setWorkDir(workDir) {
        const normalized = normalizeWorkDir(workDir);
        if (!normalized) return getWorkDir();
        setWorkDirRoot(normalized);
        // 作業ディレクトリが変わったので、認証情報/トークンの参照先も含めて作り直す
        this.youtubeUploader = null;
        return getWorkDir();
    }

    _getYoutubeUploader() {
        const configDir = getYoutubeConfigDir();
        if (!this.youtubeUploader) {
            this.youtubeUploader = new YouTubeUploader(this.youtubeTokenFile, { configDir });
        } else {
            if (typeof this.youtubeUploader.setConfigDir === 'function') {
                this.youtubeUploader.setConfigDir(configDir);
            }
            this.youtubeUploader.setTokenFileName(this.youtubeTokenFile);
        }
        if (this.currentInstance) {
            this.currentInstance.setYoutubeTokenFile(this.youtubeTokenFile);
        }
        return this.youtubeUploader;
    }

    _resolveIntroBgVideoPath(videoNameOrPath) {
        // introBgVideo が未指定/空の場合は「イントロ無し」として扱う
        if (videoNameOrPath === null || videoNameOrPath === undefined) {
            return null;
        }
        if (typeof videoNameOrPath !== 'string') {
            return null;
        }

        let candidate = videoNameOrPath.trim();
        if (!candidate) {
            return null;
        }
        if (!path.isAbsolute(candidate)) {
            candidate = path.join(getAssetsPath(), 'backgrounds', candidate);
        }

        try {
            if (fs.existsSync(candidate)) {
                return candidate;
            }
        } catch (error) {
            console.error('イントロ背景動画の存在確認に失敗しました:', error);
        }

        console.warn(`イントロ背景動画が見つからないためスキップします: ${candidate}`);
        return null;
    }

    getAvailableIntroBgVideos() {
        try {
            const bgDir = path.join(getAssetsPath(), 'backgrounds');
            if (!fs.existsSync(bgDir)) return [];
            const files = fs.readdirSync(bgDir).filter((name) => {
                const ext = path.extname(name).toLowerCase();
                return ['.mov', '.mp4', '.mkv', '.avi'].includes(ext);
            });
            return files.map((fileName) => ({
                fileName,
                path: path.join(bgDir, fileName),
                isDefault: false
            }));
        } catch (error) {
            console.error('イントロ背景動画一覧の取得に失敗しました:', error);
            return [];
        }
    }

    setIntroBgVideo(videoNameOrPath) {
        const resolved = this._resolveIntroBgVideoPath(videoNameOrPath);
        this.currentIntroBgVideo = resolved;

        if (this.currentInstance && typeof this.currentInstance.setIntroBgVideo === 'function') {
            this.currentInstance.setIntroBgVideo(resolved);
        }

        this.instances.forEach((instance) => {
            if (instance && typeof instance.setIntroBgVideo === 'function') {
                instance.setIntroBgVideo(resolved);
            }
        });

        return this.currentIntroBgVideo;
    }

    setYoutubeTokenFile(tokenFileName) {
        if (typeof tokenFileName !== 'string' || !tokenFileName.trim()) {
            return;
        }
        const normalized = tokenFileName.trim();
        this.youtubeTokenFile = normalized;
        if (this.youtubeUploader) {
            this.youtubeUploader.setTokenFileName(normalized);
        }
        if (this.currentInstance) {
            this.currentInstance.setYoutubeTokenFile(normalized);
        }
        this.instances.forEach(instance => {
            if (instance && typeof instance.setYoutubeTokenFile === 'function') {
                instance.setYoutubeTokenFile(normalized);
            }
        });
    }

    hasYoutubeCredentials() {
        try {
            const credentialsPath = path.join(getYoutubeConfigDir(), YOUTUBE_CREDENTIALS_FILE);
            return fs.existsSync(credentialsPath);
        } catch (error) {
            console.error('YouTube credentials check failed:', error);
            return false;
        }
    }

    /**
     * 利用可能なYouTubeトークン(.json)の一覧を取得
     * @returns {string[]}
     */
    getAvailableYoutubeTokenFiles() {
        try {
            const configDir = getYoutubeConfigDir();
            if (!fs.existsSync(configDir)) return [];
            const entries = fs.readdirSync(configDir, { withFileTypes: true });
            return entries
                .filter((entry) => entry.isFile())
                .map((entry) => entry.name)
                .filter((name) => {
                    const lower = name.toLowerCase();
                    return lower.endsWith('.json') && lower !== YOUTUBE_CREDENTIALS_FILE;
                })
                .sort((a, b) => a.localeCompare(b));
        } catch (error) {
            console.error('YouTube token list retrieval failed:', error);
            return [];
        }
    }

    emitProgress(type, progress) {
        this.emit('progress', { type, progress });
    }

    emitProcessingComplete(payload = {}) {
        this.emit('processing-complete', payload);
    }

    /**
     * 利用可能なBGM(.mp3)の一覧を取得
     * @returns {Array<{fileName:string, path:string}>}
     */
    getAvailableBgms() {
        try {
            const bgDir = path.join(getAssetsPath(), 'backgrounds');
            if (!fs.existsSync(bgDir)) return [];
            const files = fs.readdirSync(bgDir).filter(name => name.toLowerCase().endsWith('.mp3'));
            return files.map(fileName => ({ fileName, path: path.join(bgDir, fileName) }));
        } catch (e) {
            console.error('BGM一覧の取得に失敗しました:', e);
            return [];
        }
    }

    /**
     * 使用するBGMのパスを設定
     * @param {string} bgmPath
     */
    setBgmPath(bgmPath) {
        try {
            const valid = bgmPath && typeof bgmPath === 'string' && fs.existsSync(bgmPath);
            if (!valid && typeof bgmPath === 'string' && bgmPath.trim()) {
                console.warn(`BGMファイルが見つからないためスキップします: ${bgmPath}`);
            }
            this.currentBgmPath = valid ? bgmPath : null;
            if (this.currentInstance) {
                this.currentInstance.currentBgmPath = this.currentBgmPath;
                this.currentInstance.setBgmVolume(this.currentBgmVolume);
            }
            this.instances.forEach(instance => {
                if (instance) {
                    instance.currentBgmPath = this.currentBgmPath;
                    if (typeof instance.setBgmVolume === 'function') {
                        instance.setBgmVolume(this.currentBgmVolume);
                    }
                }
            });
            return this.currentBgmPath;
        } catch (e) {
            console.error('BGMパス設定に失敗しました:', e);
            this.currentBgmPath = null;
            if (this.currentInstance) {
                this.currentInstance.currentBgmPath = this.currentBgmPath;
                this.currentInstance.setBgmVolume(this.currentBgmVolume);
            }
            this.instances.forEach(instance => {
                if (instance) {
                    instance.currentBgmPath = this.currentBgmPath;
                    if (typeof instance.setBgmVolume === 'function') {
                        instance.setBgmVolume(this.currentBgmVolume);
                    }
                }
            });
            return this.currentBgmPath;
        }
    }

    setBgmVolume(volume) {
        const parsed = Number(volume);
        const normalized = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 0), 1) : 0.2;
        this.currentBgmVolume = normalized;

        if (this.currentInstance && typeof this.currentInstance.setBgmVolume === 'function') {
            this.currentInstance.setBgmVolume(normalized);
        }

        this.instances.forEach(instance => {
            if (instance && typeof instance.setBgmVolume === 'function') {
                instance.setBgmVolume(normalized);
            }
        });

        return this.currentBgmVolume;
    }

    setCaptionsEnabled(enabled) {
        if (enabled === undefined || enabled === null) {
            return this.captionsEnabled;
        }
        const normalized = (typeof enabled === 'boolean')
            ? enabled
            : (typeof enabled === 'string' ? enabled.trim().toLowerCase() === 'true' : Boolean(enabled));
        this.captionsEnabled = normalized;

        if (this.currentInstance && typeof this.currentInstance.setCaptionsEnabled === 'function') {
            this.currentInstance.setCaptionsEnabled(normalized);
        }

        this.instances.forEach((instance) => {
            if (instance && typeof instance.setCaptionsEnabled === 'function') {
                instance.setCaptionsEnabled(normalized);
            }
        });

        return this.captionsEnabled;
    }

    playAudio(datas, overlapDuration = 0, playbackSpeed = 1.0, autoGenerateVideo = false, options = {}) {
        this.emit('audioPlayed', { datas, overlapDuration, playbackSpeed });

        this.stopAudio();

        if (!this.currentInstance) {
            const instance = new TTSServiceInstance();
            instance.setYoutubeInfo(this.youtubeInfo);
            // BGM設定をインスタンスへ反映
            instance.currentBgmPath = this.currentBgmPath;
            instance.setBgmVolume(this.currentBgmVolume);
            instance.setIntroBgVideo(this.currentIntroBgVideo);
            if (typeof instance.setCaptionsEnabled === 'function') {
                instance.setCaptionsEnabled(this.captionsEnabled);
            }

            // プロパティの監視を設定
            const self = this;
            ['currentPlayingProgress', 'generateAudioProgress'].forEach(prop => {
                let value = 0;
                Object.defineProperty(instance, prop, {
                    get() { return value; },
                    set(newValue) {
                        value = newValue;
                        const type = prop === 'currentPlayingProgress' ? 'playing' : 'generating';
                        console.log(`Progress update - ${type}: ${(newValue * 100).toFixed(1)}%`);
                        self.emitProgress(type, newValue);
                    }
                });
            });

            this.instances.push(instance);
            this.currentInstance = instance;
        } else {
            if (typeof this.currentInstance.setBgmVolume === 'function') {
                this.currentInstance.setBgmVolume(this.currentBgmVolume);
            }
            if (typeof this.currentInstance.setCaptionsEnabled === 'function') {
                this.currentInstance.setCaptionsEnabled(this.captionsEnabled);
            }
        }

        this.currentInstance.playAudio(datas, overlapDuration, playbackSpeed, autoGenerateVideo, options);
    }

    async pauseAudio() {
        if (!this.currentInstance) return;
        await this.currentInstance.pauseAudio();
    }

    async resumeAudio() {
        if (!this.currentInstance) return;
        await this.currentInstance.resumeAudio();
    }

    async stopAudio() {
        if (!this.currentInstance) return;
        var currentInstance = this.currentInstance;
        this.currentInstance = null;

        await currentInstance.stopAudio();
        this.instances = this.instances.filter(instance => instance !== currentInstance);
    }

    async getSpeakers() {
        return await TTsServer.getSpeakers();
    }

    async getEnglishSpeakers() {
        return await TTsServer.getEnglishSpeakers();
    }

    async nextAudio() {
        if (!this.currentInstance) return;
        await this.currentInstance.nextAudio();
    }

    async prevAudio() {
        if (!this.currentInstance) return;
        await this.currentInstance.prevAudio();
    }

    async restartAudio() {
        if (!this.currentInstance) return;
        await this.currentInstance.restartAudio();
    }

    async changePlaybackSpeed(newSpeed) {
        if (!this.currentInstance) return;
        await this.currentInstance.changePlaybackSpeed(newSpeed);
    }

    async makeVideo(backgroundPath = null) {
        if (!this.currentInstance) return null;
        this.emitProgress('video', 0); // 初期進捗を0で送信

        // パフォーマンスログ開始
        performanceLogger.addLog('makeVideo_main_start', {
            autoGenerateVideo: this.currentInstance?.autoGenerateVideo || false,
            autoUploadToYoutube: this.currentInstance?.autoUploadToYoutube || false,
            backgroundPath: backgroundPath || 'default'
        });
        const mainTimer = performanceLogger.startTimer('makeVideo_main_total');

        const result = await this.currentInstance.makeVideo(backgroundPath,
            // 進捗コールバックを追加
            (progress) => {
                this.emitProgress('video', progress);
            },
            (progress) => {
                this.emitProgress('upload', progress);
            }
        );

        // パフォーマンスログ終了と保存
        mainTimer.end({ result: !!result });
        performanceLogger.saveLogs({
            videoInfo: {
                path: result,
                autoGenerateVideo: this.currentInstance?.autoGenerateVideo || false,
                autoUploadToYoutube: this.currentInstance?.autoUploadToYoutube || false
            }
        });

        this.emitProgress('video', 1); // 完了時に100%を送信
        this.emitProcessingComplete({
            outputPath: result || null,
            autoUploadToYoutube: this.currentInstance?.autoUploadToYoutube || false
        });
        return result;
    }

    // 自動生成設定を変更するメソッドを追加
    setAutoGenerateVideo(value) {
        if (this.currentInstance) {
            this.currentInstance.setAutoGenerateVideo(value);
        }
    }

    setYoutubeInfo(youtubeInfo) {
        this.youtubeInfo = youtubeInfo;
        if (this.currentInstance) {
            this.currentInstance.setYoutubeInfo(youtubeInfo);
        }
    }

    setAutoUploadToYoutube(value) {
        if (this.currentInstance) {
            this.currentInstance.setAutoUploadToYoutube(value);
        }
    }

    async uploadToYoutube() {
        if (this.currentInstance) {
            // パフォーマンスログ開始
            const uploadTimer = performanceLogger.startTimer('uploadToYoutube');
            performanceLogger.addLog('uploadToYoutube_start', {
                videoPath: this.currentInstance.outputPath || 'unknown'
            });

            try {
                await this.currentInstance.uploadToYoutube(this.currentInstance.outputPath, (progress) => {
                    this.emitProgress('upload', progress);
                });

                // 成功時のログ
                uploadTimer.end({ success: true });
                performanceLogger.saveLogs({
                    youtubeUpload: {
                        success: true,
                        videoPath: this.currentInstance.outputPath
                    }
                });

                return true;
            } catch (error) {
                // エラー時のログ
                performanceLogger.addLog('uploadToYoutube_error', {
                    error: error.message,
                    videoPath: this.currentInstance.outputPath
                });
                uploadTimer.end({ success: false, error: error.message });
                performanceLogger.saveLogs({
                    youtubeUpload: {
                        success: false,
                        error: error.message,
                        videoPath: this.currentInstance.outputPath
                    }
                });

                throw error;
            }
        }
        return false;
    }

    _getYoutubeRedirectUriBase() {
        const uploader = this._getYoutubeUploader();
        return uploader.getDefaultRedirectUri();
    }

    async _stopYoutubeAuthSession() {
        if (this.youtubeAuthTimeout) {
            clearTimeout(this.youtubeAuthTimeout);
            this.youtubeAuthTimeout = null;
        }

        if (this.youtubeAuthServer) {
            await new Promise((resolve) => {
                try {
                    this.youtubeAuthServer.close(() => resolve());
                } catch (error) {
                    console.error('Failed to close YouTube auth server:', error);
                    resolve();
                }
            });
        }

        this.youtubeAuthServer = null;
        this.youtubeAuthState = null;
        this.youtubeAuthRedirectUri = null;
        this.tempOAuth2Client = null;
    }

    async cancelYoutubeAuth() {
        await this._stopYoutubeAuthSession();
        return { success: true };
    }

    async _startYoutubeAuthSession() {
        const uploader = this._getYoutubeUploader();
        const baseRedirectUri = this._getYoutubeRedirectUriBase();

        let parsedRedirectUri;
        try {
            parsedRedirectUri = new URL(baseRedirectUri);
        } catch (error) {
            throw new Error('redirect_uris が不正です');
        }

        if (parsedRedirectUri.protocol !== 'http:') {
            throw new Error('redirect_uris は http://localhost を指定してください');
        }

        const listenHost = parsedRedirectUri.hostname || 'localhost';
        const requestedPort = parsedRedirectUri.port ? Number(parsedRedirectUri.port) : 0;

        await this._stopYoutubeAuthSession();

        let authHandled = false;
        const sendHtml = (res, statusCode, title, message) => {
            res.writeHead(statusCode, {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'no-store'
            });
            res.end(`<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <title>${title}</title>
  <style>
    body { font-family: sans-serif; padding: 24px; line-height: 1.6; }
    .box { max-width: 560px; margin: 0 auto; }
    h1 { font-size: 20px; margin-bottom: 8px; }
  </style>
</head>
<body>
  <div class="box">
    <h1>${title}</h1>
    <p>${message}</p>
  </div>
</body>
</html>`);
        };

        const finalize = async (payload) => {
            await this._stopYoutubeAuthSession();
            this.emit('youtube-auth-complete', payload);
        };

        const server = http.createServer(async (req, res) => {
            try {
                if (req.method !== 'GET') {
                    res.writeHead(405, { Allow: 'GET' });
                    res.end();
                    return;
                }

                const requestUrl = new URL(req.url || '/', this.youtubeAuthRedirectUri || baseRedirectUri);

                if (requestUrl.pathname === '/favicon.ico') {
                    res.writeHead(204);
                    res.end();
                    return;
                }

                const errorParam = requestUrl.searchParams.get('error');
                if (errorParam) {
                    const description = requestUrl.searchParams.get('error_description') || errorParam;
                    if (!authHandled) {
                        authHandled = true;
                        await finalize({
                            success: false,
                            error: `認証がキャンセルされました: ${description}`
                        });
                    }
                    sendHtml(res, 200, '認証がキャンセルされました', 'もう一度お試しください。');
                    return;
                }

                const code = requestUrl.searchParams.get('code');
                const state = requestUrl.searchParams.get('state');

                if (!code) {
                    sendHtml(res, 400, '認証コードが取得できませんでした', 'もう一度お試しください。');
                    return;
                }

                if (!state || state !== this.youtubeAuthState) {
                    if (!authHandled) {
                        authHandled = true;
                        await finalize({
                            success: false,
                            error: '認証情報が一致しませんでした。'
                        });
                    }
                    sendHtml(res, 400, '認証情報が一致しませんでした', 'もう一度お試しください。');
                    return;
                }

                if (authHandled) {
                    sendHtml(res, 200, '認証は完了しています', 'アプリに戻ってください。');
                    return;
                }

                authHandled = true;
                try {
                    await uploader.processAuthCode(code, this.tempOAuth2Client);
                    sendHtml(res, 200, '認証が完了しました', 'アプリに戻ってください。');
                    await finalize({ success: true });
                } catch (error) {
                    console.error('Failed to process YouTube auth code:', error);
                    sendHtml(res, 500, '認証に失敗しました', 'もう一度お試しください。');
                    await finalize({
                        success: false,
                        error: '認証処理に失敗しました。'
                    });
                }
            } catch (error) {
                console.error('YouTube auth server error:', error);
                if (!authHandled) {
                    authHandled = true;
                    await finalize({
                        success: false,
                        error: '認証処理中にエラーが発生しました。'
                    });
                }
                sendHtml(res, 500, '認証に失敗しました', 'もう一度お試しください。');
            }
        });

        await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(requestedPort || 0, listenHost, resolve);
        });

        const address = server.address();
        const actualPort = typeof address === 'object' && address ? address.port : requestedPort;
        const effectiveRedirectUri = new URL(baseRedirectUri);
        if (!effectiveRedirectUri.port) {
            effectiveRedirectUri.port = String(actualPort);
        }

        const authState = crypto.randomBytes(16).toString('hex');
        this.youtubeAuthServer = server;
        this.youtubeAuthRedirectUri = effectiveRedirectUri.toString();
        this.youtubeAuthState = authState;

        let authUrl;
        let oAuth2Client;
        try {
            ({ authUrl, oAuth2Client } = uploader.getAuthUrl({
                redirectUri: this.youtubeAuthRedirectUri,
                state: authState
            }));
        } catch (error) {
            await this._stopYoutubeAuthSession();
            throw error;
        }

        this.tempOAuth2Client = oAuth2Client;

        this.youtubeAuthTimeout = setTimeout(() => {
            finalize({
                success: false,
                error: '認証がタイムアウトしました。'
            }).catch(() => { });
        }, YOUTUBE_AUTH_TIMEOUT_MS);

        return { authUrl, authState: true };
    }

    // YouTube認証状態をチェックするメソッド
    async checkYoutubeAuth() {
        try {
            const uploader = this._getYoutubeUploader();
            const tokenPath = uploader.TOKEN_PATH;

            // トークンファイルが存在するか確認
            if (!fs.existsSync(tokenPath)) {
                console.log('YouTube token file does not exist');
                return false;
            }

            // トークンファイルを読み込み
            const token = JSON.parse(fs.readFileSync(tokenPath));

            // トークンの詳細情報をログ出力
            console.log('Token details:', JSON.stringify({
                scope: token.scope,
                token_type: token.token_type,
                refresh_token_exists: !!token.refresh_token,
                refresh_token_expires_in: token.refresh_token_expires_in,
                expiry_date: token.expiry_date
            }, null, 2));

            // 現在の日時
            const now = Date.now();
            const nowDateObj = new Date(now);
            console.log('Current date (readable):', nowDateObj.toISOString());

            // リフレッシュトークンの有効期限を計算
            if (token.refresh_token && token.expiry_date) {
                // expiry_dateをトークン発行日として扱う
                const tokenIssueDate = token.expiry_date;
                const tokenIssueDateObj = new Date(tokenIssueDate);

                if (token.refresh_token_expires_in != null) {
                    // リフレッシュトークンの有効期限 = 発行日 + 7日間
                    const refreshTokenExpiryDate = tokenIssueDate + (token.refresh_token_expires_in * 1000);
                    const refreshTokenExpiryDateObj = new Date(refreshTokenExpiryDate);

                    console.log('Token issue date:', tokenIssueDateObj.toISOString());
                    console.log('Refresh token expiry date:', refreshTokenExpiryDateObj.toISOString());

                    // 有効期限の判断: 現在日時 < リフレッシュトークンの有効期限
                    const isValid = now < refreshTokenExpiryDate;
                    console.log('Is token valid:', isValid);
                    return isValid;
                } else {
                    return true;
                }
            }

            // リフレッシュトークンがない場合や必要な情報がない場合はfalseを返す
            console.log('Insufficient token information for validation');
            return false;
        } catch (error) {
            console.error('YouTube auth check failed:', error);
            return false;
        }
    }

    // YouTube認証URLを取得するメソッド
    async getYoutubeAuthUrl() {
        try {
            return await this._startYoutubeAuthSession();
        } catch (error) {
            console.error('Failed to get YouTube auth URL:', error);
            throw error;
        }
    }

    // YouTube認証コードを処理するメソッド
    async submitYoutubeAuthCode(code) {
        try {
            if (!this.tempOAuth2Client) {
                throw new Error('認証セッションが見つかりません。再度認証URLを取得してください。');
            }

            const uploader = this._getYoutubeUploader();
            await uploader.processAuthCode(code, this.tempOAuth2Client);

            // 一時的に保存したoAuth2Clientをクリア
            this.tempOAuth2Client = null;

            return true;
        } catch (error) {
            console.error('Failed to process YouTube auth code:', error);
            throw error;
        }
    }

    /**
     * 背景画像を保存
     * @param {Buffer} imageData - 画像データ
     * @returns {Promise<string>} 保存されたファイルのパス
     */
    async saveBackgroundImage(imageData) {
        try {
            // ディレクトリが存在しない場合は作成
            if (!fs.existsSync(TEMP_DIR)) {
                fs.mkdirSync(TEMP_DIR, { recursive: true });
            }

            await fs.promises.writeFile(TEMP_BG_PATH, imageData);
            return TEMP_BG_PATH;
        } catch (error) {
            console.error('背景画像の保存に失敗しました:', error);
            throw error;
        }
    }

    /**
     * 背景画像を作成
     * @param {string} text - 背景画像に表示するテキスト
     * @returns {Promise<void>}
     */
    async createBackgroundImage(text) {
        console.log('createBackgroundImage', text);

        if (!fs.existsSync(TEMP_DIR)) {
            fs.mkdirSync(TEMP_DIR, { recursive: true });
        }

        const layout = getVideoLayout(this.currentInstance?.videoFormat);
        const extent = `${layout.width}x${layout.height}`;
        const fontPath = getFontPath('NotoSansJP-Black.ttf');

        const textFilePath = path.join(TEMP_DIR, `bg_text_${Date.now()}.txt`);
        await fs.promises.writeFile(textFilePath, String(text ?? ''), 'utf8');

        const command = `
        "${MAGICK_BIN}" -size ${extent} xc:black \\
        -font "${fontPath}" \\
        -pointsize 100 \\
        -interline-spacing -20 \\
        \\( -size ${extent} xc:transparent -fill gray50 -gravity north -annotate +2+235 "@${textFilePath}" -background black -shadow 50x15+0+0 \\) \\
        -gravity north -compose Over -composite \\
        -fill white -annotate +0+230 "@${textFilePath}" \\
        -background none -extent ${extent} \\
        "${TEMP_BG_PATH}"
        `;

        try {
            await new Promise((resolve, reject) => {
                exec(command, (err, stdout, stderr) => {
                    if (err) {
                        console.error('背景画像の作成に失敗しました:', err, stderr);
                        reject(err);
                        return;
                    }
                    resolve();
                });
            });
            console.log('画像の生成が完了しました');
        } finally {
            try { fs.unlinkSync(textFilePath); } catch (_) { /* ignore */ }
        }
    }

    /**
     * スピーカー用の動画を保存
     * @param {string} speakerId - スピーカーID
     * @param {Buffer} videoData - 動画データ
     * @returns {Promise<string>} 保存されたファイルのパス
     */
    async saveSpeakerVideo(speakerId, videoData) {
        try {
            const speakerDir = getSpeakerVideosDir();
            ensureDirSync(speakerDir);

            const videoPath = path.join(speakerDir, `${speakerId}.mp4`);
            await fs.promises.writeFile(videoPath, videoData);
            return videoPath;
        } catch (error) {
            console.error('スピーカー動画の保存に失敗しました:', error);
            throw error;
        }
    }

    /**
     * スピーカーIDに対応する動画パスを取得
     * @param {string} speakerId - スピーカーID
     * @param {string} [mood] - ムード（例: "angry"）。存在する場合は _${mood} を付与して検索し、なければ通常パスにフォールバック
     * @returns {string|null} 動画ファイルのパス（存在しない場合は null）
     */
    getSpeakerVideoPath(speakerId, mood) {
        const speakerDir = getSpeakerVideosDir();
        // ムード指定がある場合は id_ mood + prefix の順に探索
        if (mood) {
            const moodVideoPath = path.join(
                speakerDir,
                `${speakerId}_${mood}${this.speakerVideoPrefix || ''}.mp4`
            );
            if (fs.existsSync(moodVideoPath)) {
                return moodVideoPath;
            }
        }

        // 通常のパス（ムードなし）
        const defaultVideoPath = path.join(
            speakerDir,
            `${speakerId}${this.speakerVideoPrefix || ''}.mp4`
        );
        return fs.existsSync(defaultVideoPath) ? defaultVideoPath : null;
    }

    // ローカル画像をBase64に変換する
    async getLocalImageAsBase64(filePath) {
        try {
            // ファイルの存在を確認
            if (!fs.existsSync(filePath)) {
                return { success: false, error: 'ファイルが存在しません' };
            }

            // ファイルの拡張子をチェック
            const ext = path.extname(filePath).toLowerCase();
            const supportedExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'];

            if (!supportedExtensions.includes(ext)) {
                return { success: false, error: 'サポートされていない画像形式です' };
            }

            // ファイルを読み込み
            const data = fs.readFileSync(filePath);
            const base64 = `data:image/${ext.substring(1)};base64,${data.toString('base64')}`;

            return { success: true, base64 };
        } catch (error) {
            console.error('画像のBase64変換エラー:', error);
            return { success: false, error: error.message };
        }
    }

    // 動画ファイルからサムネイルを生成する
    async generateThumbnailFromVideo(videoPath) {
        return new Promise((resolve) => {
            try {
                // ファイルの存在を確認
                if (!fs.existsSync(videoPath)) {
                    resolve({ success: false, error: 'ファイルが存在しません' });
                    return;
                }

                // ファイルの統計情報を取得してファイルサイズを含めたハッシュを生成
                const stats = fs.statSync(videoPath);
                const fileInfo = `${videoPath}:${stats.size}`;
                const fileHash = crypto.createHash('md5').update(fileInfo).digest('hex');

                console.log('fileHash', fileInfo);

                // ハッシュベースのサムネイル画像のパスを生成
                const thumbnailPath = path.join(
                    TEMP_DIR,
                    `thumbnail-${fileHash}.jpg`
                );

                // 既にサムネイルが存在する場合は既存のファイルを使用
                if (fs.existsSync(thumbnailPath)) {
                    console.log(`[DEBUG] 既存のサムネイルを使用します: ${thumbnailPath}`);
                    try {
                        // 既存のサムネイルをBase64エンコード
                        const data = fs.readFileSync(thumbnailPath);
                        const base64 = `data:image/jpeg;base64,${data.toString('base64')}`;

                        resolve({
                            success: true,
                            base64,
                            thumbnailPath
                        });
                        return;
                    } catch (error) {
                        console.error('既存サムネイルの読み込みエラー:', error);
                        // 既存ファイルが破損している場合は削除して再生成
                        try {
                            fs.unlinkSync(thumbnailPath);
                        } catch (unlinkError) {
                            console.warn('破損サムネイルの削除に失敗:', unlinkError);
                        }
                    }
                }

                // ffmpegを使用して動画のサムネイルを生成
                ffmpeg(videoPath)
                    .screenshots({
                        timestamps: ['10%'], // 動画の10%の位置からサムネイルを取得
                        filename: path.basename(thumbnailPath),
                        folder: path.dirname(thumbnailPath),
                        size: '1920x1080', // 解像度を1920x1080に固定
                    })
                    .on('end', () => {
                        try {
                            // サムネイル生成が成功したか確認
                            if (!fs.existsSync(thumbnailPath)) {
                                console.error('サムネイルが生成されませんでした');
                                resolve({ success: false, error: 'サムネイルが生成されませんでした' });
                                return;
                            }

                            // 生成されたサムネイルをBase64エンコード
                            const data = fs.readFileSync(thumbnailPath);
                            const base64 = `data:image/jpeg;base64,${data.toString('base64')}`;

                            // 一時ファイルは削除せずにパスを返す
                            resolve({
                                success: true,
                                base64,
                                thumbnailPath
                            });
                        } catch (error) {
                            console.error('サムネイルのBase64エンコードエラー:', error);
                            resolve({ success: false, error: error.message });
                        }
                    })
                    .on('error', (err) => {
                        console.error('サムネイル生成エラー:', err);
                        resolve({ success: false, error: err.message });
                    });
            } catch (error) {
                console.error('サムネイル生成の例外:', error);
                resolve({ success: false, error: error.message });
            }
        });
    }

    /**
     * UI から呼び出してスピーカー動画のファイル名に付与する接頭辞を設定する
     * @param {string} prefix 例: "_v" など。null/undefined の場合は空文字にする。
     */
    setSpeakerVideoPrefix(prefix) {
        this.speakerVideoPrefix = (typeof prefix === 'string') ? prefix : '';
    }
}


class TTSServiceInstance {

    constructor() {
        this.audioFiles = [];
        this.isActive = true;
        this.isPause = false;
        this.currentPlayingAudioFile = null;
        this.skipCount = 0;
        this.isSkipping = false;
        this.playbackSpeed = 1.0;
        this.currentPlayingProgress = 0;
        this.generateAudioProgress = 0;
        this.autoGenerateVideo = false;
        this.autoUploadToYoutube = false;
        this.lastOverlapDuration = 0;
        this.clipsAdjustedForSpeed = false;
        this.currentBgmPath = null;
        this.currentBgmVolume = 0.2;
        this.youtubeTokenFile = 'youtube-token.json';
        this.youtubeUploader = null;
        this.introBgVideoPath = null;
        this.captionsEnabled = true;
        this.videoFormat = VIDEO_FORMATS.LANDSCAPE;
    }

    setBgmVolume(volume) {
        const parsed = Number(volume);
        const normalized = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 0), 1) : 0.2;
        this.currentBgmVolume = normalized;
    }

    setIntroBgVideo(videoPath) {
        // null/空文字は「イントロ無し」として扱う
        if (videoPath === null || videoPath === undefined) {
            this.introBgVideoPath = null;
            return;
        }
        if (typeof videoPath !== 'string') {
            this.introBgVideoPath = null;
            return;
        }
        const trimmed = videoPath.trim();
        this.introBgVideoPath = trimmed ? trimmed : null;
    }

    setYoutubeTokenFile(tokenFileName) {
        if (typeof tokenFileName === 'string' && tokenFileName.trim()) {
            this.youtubeTokenFile = tokenFileName.trim();
        }
    }

    setCaptionsEnabled(enabled) {
        if (enabled === undefined || enabled === null) {
            return;
        }
        this.captionsEnabled = (typeof enabled === 'boolean')
            ? enabled
            : (typeof enabled === 'string' ? enabled.trim().toLowerCase() === 'true' : Boolean(enabled));
    }

    /**
     * 音声クエリを作成
     * @param {string} text - 合成するテキスト
     * @param {string} speakerId - 話者ID
     * @returns {Promise<Object>} 音声クエリ
     */
    async createAudioQuery(text, speakerId) {
        return TTsServer.withServerCheck(async () => {
            try {
                const response = await axios.post(`${AIVIS_URL}/audio_query`, null, {
                    params: { text, speaker: speakerId }
                });
                return response.data;
            } catch (error) {
                console.error('音声クエリの作成に失敗しました:', error);
                throw error;
            }
        });
    }

    /**
     * 音声を合成
     * @param {Object} audioQuery - 音声クエリ
     * @param {string} speakerId - 話者ID
     * @returns {Promise<Buffer>} 音声データ
     */
    async synthesize(audioQuery, speakerId) {
        return TTsServer.withServerCheck(async () => {
            try {
                const response = await axios.post(`${AIVIS_URL}/synthesis`, audioQuery, {
                    params: { speaker: speakerId },
                    responseType: 'arraybuffer'
                });
                return response.data;
            } catch (error) {
                console.error('音声合成に失敗しました:', error);
                throw error;
            }
        });
    }

    /**
     * 一時ファイル名を生成
     * @returns {string} 一時ファイルのパス
     */
    generateTempFilePath() {
        const hash = crypto.randomBytes(8).toString('hex');
        return path.join(TEMP_DIR, `audio-${hash}.wav`);
    }

    /**
     * 話者モデルを初期化
     * @param {string} speakerId - 話者ID
     */
    async initializeSpeaker(speakerId) {
        return TTsServer.withServerCheck(async () => {
            try {
                await axios.post(`${AIVIS_URL}/initialize_speaker`, null, {
                    params: { speaker: speakerId }
                });
            } catch (error) {
                console.error('話者モデルの初期化に失敗しました:', error);
                throw error;
            }
        });
    }

    /**
     * 単一のテキストの音声生成
     * @param {string} text - 合成するテキスト
     * @param {string} speakerId - 話者ID
     * @returns {Promise<string>} 生成された音声ファイルのパス
     */
    async generateSingleAudio(audioFile) {
        const language = normalizeLanguage(audioFile?.language);
        if (language === LANGUAGE_CODES.ENGLISH) {
            await this.generateEnglishAudio(audioFile);
            audioFile.created = true;
            return;
        }

        await this.initializeSpeaker(audioFile.speakerId);

        const audioQuery = await this.createAudioQuery(audioFile.text, audioFile.speakerId);

        const audioData = await this.synthesize(audioQuery, audioFile.speakerId);

        if (audioFile.isEcho) {
            // エコー効果用の一次ファイルを作成
            const tempRawPath = audioFile.path + '.raw.wav';
            fs.writeFileSync(tempRawPath, audioData);

            // ffmpegでエコー効果を適用
            // strong echo: aecho=0.8:0.9:ECHO_DELAY:0.3
            await new Promise((resolve, reject) => {
                ffmpeg(tempRawPath)
                    .audioFilters(`aecho=0.8:0.9:${ECHO_DELAY}:0.3`)
                    .save(audioFile.path)
                    .on('end', () => {
                        try { fs.unlinkSync(tempRawPath); } catch (e) { }
                        resolve();
                    })
                    .on('error', (err) => {
                        console.error('Echo effect failed:', err);
                        // 失敗時は元のデータをそのまま使う
                        fs.writeFileSync(audioFile.path, audioData);
                        try { fs.unlinkSync(tempRawPath); } catch (e) { }
                        resolve();
                    });
            });
        } else {
            fs.writeFileSync(audioFile.path, audioData);
        }

        audioFile.created = true;
    }

    async generateEnglishAudio(audioFile) {
        const voiceId = (audioFile?.speakerId ?? '').toString().trim();
        if (!voiceId) {
            throw new Error('English TTS requires a valid speakerId (voice_id).');
        }

        if (!fs.existsSync(EN_TTS_PYTHON)) {
            throw new Error(`English TTS python not found at ${EN_TTS_PYTHON}`);
        }
        if (!fs.existsSync(EN_TTS_SCRIPT_PATH)) {
            throw new Error(`English TTS script not found at ${EN_TTS_SCRIPT_PATH}`);
        }

        const textContent = typeof audioFile?.text === 'string' ? audioFile.text : '';
        const voiceArg = JSON.stringify(voiceId);
        const textArg = JSON.stringify(textContent);
        const outputArg = JSON.stringify(audioFile.path);
        const command = `"${EN_TTS_PYTHON}" "${EN_TTS_SCRIPT_PATH}" ${voiceArg} ${textArg} ${outputArg}`;

        await new Promise((resolve, reject) => {
            exec(command, { shell: '/bin/zsh' }, (error, stdout, stderr) => {
                if (stdout && stdout.trim()) {
                    console.log('[English TTS stdout]', stdout.trim());
                }
                if (error) {
                    console.error('[English TTS error]', stderr || error.message);
                    reject(new Error(stderr || error.message));
                    return;
                }
                if (stderr && stderr.trim()) {
                    console.warn('[English TTS stderr]', stderr.trim());
                }
                resolve();
            });
        });

        // English TTSでもエコーが必要な場合
        if (audioFile.isEcho && fs.existsSync(audioFile.path)) {
            const tempRawPath = audioFile.path + '.raw.wav';
            fs.renameSync(audioFile.path, tempRawPath);

            await new Promise((resolve) => {
                ffmpeg(tempRawPath)
                    .audioFilters(`aecho=0.8:0.9:${ECHO_DELAY}:0.3`)
                    .save(audioFile.path)
                    .on('end', () => {
                        try { fs.unlinkSync(tempRawPath); } catch (e) { }
                        resolve();
                    })
                    .on('error', (err) => {
                        console.error('Echo effect failed (EN):', err);
                        fs.renameSync(tempRawPath, audioFile.path);
                        resolve();
                    });
            });
        }
    }
    /**
     * 音声ファイルの長さを取得
     * @param {string} filePath - 音声ファイルのパス
     * @returns {Promise<number>} 音声ファイルの長さ（秒）
     */
    getAudioDuration(filePath) {
        return new Promise((resolve, reject) => {
            exec(`afinfo "${filePath}"`, (error, stdout, stderr) => {
                if (error) {
                    reject(`エラー: ${error.message}`);
                    return;
                }
                if (stderr) {
                    reject(`標準エラー: ${stderr}`);
                    return;
                }

                const durationLine = stdout
                    .split('\n')
                    .find(line => line.trim().startsWith('estimated duration:'));

                if (durationLine) {
                    const durationMatch = durationLine.match(/estimated duration: ([\d.]+) sec/);
                    if (durationMatch && durationMatch[1]) {
                        resolve(parseFloat(durationMatch[1]));
                        return;
                    }
                }

                reject('音声ファイルの長さを取得できませんでした');
            });
        });
    }

    /**
     * 生成済み音声ファイル群から字幕SRTを書き出す
     * 出力先: TEMP_DIR/_codex_/captions.srt
     */
    async writeCaptionsSrt(overlapDuration = 0) {
        try {
            await this._ensureAudioMetadata(overlapDuration);
            const speed = (typeof this.playbackSpeed === 'number' && this.playbackSpeed > 0)
                ? this.playbackSpeed
                : 1.0;
            const introOffset = (typeof this.introClipDuration === 'number' && Number.isFinite(this.introClipDuration) && this.introClipDuration >= 0)
                ? this.introClipDuration
                : 0;

            const cues = [];
            for (let i = 0; i < this.audioFiles.length; i++) {
                const file = this.audioFiles[i];

                // セクション/挿入動画は字幕対象外
                if (!file || file.isSection || file.insertVideo) continue;

                // 生成失敗などでファイルがない場合はスキップ
                if (!file.created || !file.path || !fs.existsSync(file.path)) {
                    continue;
                }

                const text = typeof file.text === 'string' ? file.text.trim() : String(file.text ?? '').trim();
                if (!text) continue;

                const startTime = (typeof file.startTime === 'number' && isFinite(file.startTime) && file.startTime >= 0)
                    ? file.startTime
                    : null;
                if (startTime === null) continue;

                let durationSec = (typeof file.duration === 'number' && isFinite(file.duration)) ? file.duration : null;
                if (durationSec === null) {
                    try {
                        durationSec = await this.getAudioDuration(file.path);
                        if (typeof durationSec === 'number' && isFinite(durationSec)) {
                            file.duration = durationSec;
                        }
                    } catch (e) {
                        console.error('字幕用の音声長取得に失敗:', e);
                        continue;
                    }
                }
                if (typeof durationSec !== 'number' || !isFinite(durationSec) || durationSec <= 0) continue;

                const adjustedDuration = durationSec / speed;
                const start = introOffset + startTime;
                const end = introOffset + startTime + Math.max(0.05, adjustedDuration);
                cues.push({ start, end, text });
            }

            cues.sort((a, b) => (a.start === b.start ? 0 : a.start < b.start ? -1 : 1));
            // オーバーラップがある場合は、次の開始時刻で前の字幕を切って重なりを避ける
            for (let i = 0; i < cues.length - 1; i++) {
                const nextStart = cues[i + 1].start;
                if (Number.isFinite(nextStart) && nextStart > cues[i].start && nextStart < cues[i].end) {
                    cues[i].end = Math.max(cues[i].start + 0.05, nextStart);
                }
            }

            const outDir = path.join(TEMP_DIR, '_codex_');
            // 既存の _codex_ ディレクトリがあれば削除してから再作成
            try {
                if (fs.existsSync(outDir)) {
                    fs.rmSync(outDir, { recursive: true, force: true });
                }
            } catch (e) {
                console.error('既存の _codex_ ディレクトリ削除に失敗:', e);
            }
            if (!fs.existsSync(outDir)) {
                fs.mkdirSync(outDir, { recursive: true });
            }

            const outPath = path.join(outDir, 'captions.srt');
            fs.writeFileSync(outPath, buildSrtContent(cues), 'utf8');
            console.log(`字幕SRTを書き出しました: ${outPath}`);

            this.lastCaptionsSrtPath = outPath;
            return outPath;
        } catch (error) {
            console.error('字幕SRTの書き出しに失敗しました:', error);
            return null;
        }
    }

    async generateYoutubeChaptersFromCaptionsSrt(srtPath) {
        const resolvedSrtPath = (typeof srtPath === 'string' && srtPath.trim()) ? srtPath.trim() : this.lastCaptionsSrtPath;
        if (!resolvedSrtPath || !fs.existsSync(resolvedSrtPath)) {
            console.warn('SRTが見つからないため、チャプター生成をスキップします:', resolvedSrtPath);
            return null;
        }

        const outDir = path.dirname(resolvedSrtPath);

        // _codex_ ディレクトリで git init を実行
        try {
            await new Promise((resolve) => {
                exec('git init', { cwd: outDir }, (err, stdout, stderr) => {
                    if (err) {
                        console.error('git init に失敗:', err, stderr);
                    } else {
                        console.log('git init 完了:', stdout);
                    }
                    resolve();
                });
            });
        } catch (e) {
            console.error('git 初期化処理で例外:', e);
        }

        // codex exec を実行（SRTからYouTubeチャプター生成）
        try {
            const firstSpokenLanguage = normalizeLanguage(
                Array.isArray(this.audioFiles)
                    ? this.audioFiles.find((file) => file && !file.isSection && !file.insertVideo)?.language
                    : undefined
            );
            const codexPrompt = (firstSpokenLanguage === LANGUAGE_CODES.ENGLISH)
                ? 'Create YouTube chapters from captions.srt. Use the format: 00:00 Intro. Write chapter titles in English. Save the result to chapter.txt.'
                : 'captions.srtの内容からYoutube用のチャプターを作成してください。「00:00 イントロ」のフォーマットです。内容はchapter.txtに保存してください';
            const codexCmd = `codex exec \\
  --cd "${outDir}" \\
  --sandbox workspace-write \\
  --full-auto \\
  "${codexPrompt}"`;
            await new Promise((resolve) => {
                exec(codexCmd, { cwd: outDir }, (err, stdout, stderr) => {
                    if (err) {
                        console.error('codex exec に失敗:', err, stderr);
                    } else {
                        console.log('codex exec 実行結果:', stdout);
                    }
                    resolve();
                });
            });
        } catch (e) {
            console.error('codex 実行処理で例外:', e);
        }

        // chapter.txt を読み込み、YouTube説明文に追記
        try {
            const chapterPath = path.join(outDir, 'chapter.txt');
            if (fs.existsSync(chapterPath)) {
                const chapterContent = fs.readFileSync(chapterPath, 'utf8').trim();
                if (chapterContent) {
                    this.youtubeInfo = this.youtubeInfo || {};
                    const baseDesc = this.youtubeInfo.description || '';
                    this.youtubeInfo.description = baseDesc
                        ? `${baseDesc}\n\n${chapterContent}`
                        : chapterContent;
                    console.log('YouTube説明文にチャプターを追記しました');
                } else {
                    console.warn('chapter.txt は空でした');
                }
            } else {
                console.warn('chapter.txt が見つかりませんでした:', chapterPath);
            }
        } catch (e) {
            console.error('chapter.txt 取り込みに失敗:', e);
        }

        return path.join(outDir, 'chapter.txt');
    }

    // 互換のため残す（旧: JSON出力+codex → 新: SRT出力+codex）
    async writeCaptionsTimecodes(overlapDuration = 0) {
        const srtPath = await this.writeCaptionsSrt(overlapDuration);
        await this.generateYoutubeChaptersFromCaptionsSrt(srtPath);
        return srtPath;
    }



    async _ensureAudioMetadata(overlapDuration = 0) {
        if (!Array.isArray(this.audioFiles) || this.audioFiles.length === 0) {
            return;
        }

        const speed = (typeof this.playbackSpeed === 'number' && this.playbackSpeed > 0)
            ? this.playbackSpeed
            : 1.0;

        let currentTime = 0;

        for (let i = 0; i < this.audioFiles.length; i++) {
            const file = this.audioFiles[i];

            if (file && file.insertVideo) {
                if (!fs.existsSync(file.path)) {
                    console.warn(`挿入動画が存在しません: ${file.path}`);
                    continue;
                }

                if (typeof file.duration !== 'number' || !isFinite(file.duration) || file.duration < 0) {
                    file.duration = Math.max(0, file.videoEndOffset - file.videoStartOffset);
                }

                if (typeof file.requestedStartTime === 'number' && isFinite(file.requestedStartTime) && file.requestedStartTime >= 0) {
                    currentTime = file.requestedStartTime;
                }

                file.startTime = currentTime;

                if (typeof file.duration === 'number' && isFinite(file.duration) && file.duration >= 0) {
                    const step = Math.max(0, (file.duration / speed) - (overlapDuration || 0));
                    currentTime += step;
                }
                continue;
            }

            if (file && file.isSection) {
                if (typeof file.duration !== 'number' || !isFinite(file.duration) || file.duration < 0) {
                    file.duration = 1;
                }

                file.startTime = currentTime;

                if (typeof file.duration === 'number' && isFinite(file.duration) && file.duration >= 0) {
                    currentTime += file.duration;
                }
                continue;
            }

            if (!file || !file.path || !fs.existsSync(file.path)) {
                continue;
            }

            if (typeof file.duration !== 'number' || !isFinite(file.duration) || file.duration < 0) {
                try {
                    const duration = await this.getAudioDuration(file.path);
                    if (typeof duration === 'number' && isFinite(duration) && duration >= 0) {
                        file.duration = duration;
                    } else {
                        file.duration = 0;
                    }
                } catch (error) {
                    console.error('音声長の取得に失敗しました:', error);
                    file.duration = 0;
                }
            }

            if (typeof file.requestedStartTime === 'number' && isFinite(file.requestedStartTime) && file.requestedStartTime >= 0) {
                currentTime = file.requestedStartTime;
            }

            if (!Number.isFinite(currentTime) || currentTime < 0) {
                currentTime = 0;
            }
            file.startTime = currentTime;

            const baseDuration = (typeof file.duration === 'number' && isFinite(file.duration)) ? file.duration : 0;
            const adjusted = baseDuration / speed;
            const step = Math.max(0, adjusted - (overlapDuration || 0));
            currentTime += step;
        }
    }

    async _playAudio(audioFile, overlapDuration = 0) {

        return new Promise(async (resolve, reject) => {

            // 音声ファイルが生成されるまで待機
            while (!audioFile.created) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }


            if (!this.isActive || this.isSkipping) {
                resolve();
                return;
            }

            let duration = (typeof audioFile.duration === 'number' && isFinite(audioFile.duration))
                ? audioFile.duration
                : null;

            if (duration === null) {
                duration = await this.getAudioDuration(audioFile.path);
                if (typeof duration === 'number' && isFinite(duration)) {
                    audioFile.duration = duration;
                }
            }

            if (typeof duration !== 'number' || !isFinite(duration)) {
                duration = 0;
            }

            // 速度は常に1.0（元の速度）で再生し、後で動画作成時に適用
            const newPlayer = player.play(audioFile.path, {
                afplay: ['-q', '1']
            }, (err) => {

                if (err) {
                    reject(err);
                }

                // 再生が終了したらプレイヤーを削除
                audioFile.player = null;
                audioFile.played = true;
            });

            audioFile.player = newPlayer;

            // 再生時間まで待機 (playbackSpeedを考慮)
            const adjustedDuration = duration / this.playbackSpeed;
            const startTime = Date.now();
            while (!this.isSkipping) {
                await new Promise(resolve => setTimeout(resolve, 100));
                if (adjustedDuration && (Date.now() - startTime) >= (adjustedDuration - overlapDuration) * 1000) {
                    break;
                }
            }

            resolve();

        });
    }

    async generateAudio(list) {
        // リストを作成
        for (let i = 0; i < list.length; i++) {
            const item = list[i];
            if (item && item.insertVideo) {
                this.audioFiles.push({
                    insertVideo: true,
                    path: item.path,
                    videoStartOffset: item.videoStartOffset,
                    videoEndOffset: item.videoEndOffset,
                    text: '',
                    created: true,
                    player: null,
                    played: false,
                    creating: false,
                    speakerId: item.speakerId,
                    imagePath: item.imagePath,
                    callout: item.callout,
                    mood: item.mood,
                    requestedStartTime: item.requestedStartTime,
                    startTime: null,
                    duration: item.duration,
                    language: normalizeLanguage(item.language),
                    effect: item.effect
                });
                continue;
            }

            if (item && item.isSection) {
                this.audioFiles.push({
                    isSection: true,
                    section: item.section,
                    path: null,
                    text: '',
                    created: true,
                    player: null,
                    played: false,
                    creating: false,
                    speakerId: item.speakerId,
                    duration: item.duration,
                    startTime: null,
                    se: item.se
                });
                continue;
            }

            const tempFile = this.generateTempFilePath();
            const newEntry = {
                path: tempFile,
                created: false,
                player: null,
                played: false,
                text: item.text,
                creating: false,
                speakerId: item.speakerId,
                imagePath: item.imagePath, // Use the path passed from playAudio
                callout: item.callout,
                mood: item.mood,
                requestedStartTime: item.requestedStartTime,
                startTime: null,
                duration: null,
                language: normalizeLanguage(item.language),
                isEcho: item.isEcho,
                se: item.se,
                effect: item.effect
            };
            this.audioFiles.push(newEntry);
        }

        // 音声生成
        let failedGenerations = 0;
        for (let i = 0; i < this.audioFiles.length; i++) {
            this.generateAudioProgress = i / this.audioFiles.length;
            const audioFile = this.audioFiles[i];
            try {
                if (audioFile.created) {
                    console.log(`Skipping generation for created item (index: ${i}, type: ${audioFile.isSection ? 'section' : (audioFile.insertVideo ? 'video' : 'unknown')})`);
                    continue;
                }

                if (!audioFile.insertVideo) {
                    audioFile.creating = true;
                    await this.generateSingleAudio(audioFile);
                    audioFile.created = true;
                }
                audioFile.creating = false;
            } catch (error) {
                console.error('音声生成に失敗しました:', error);
                failedGenerations++;
            } finally {
                audioFile.creating = false;
            }
            if (!this.isActive) return;
        }
        this.generateAudioProgress = 1;

        // すべての音声が生成されたら、自動生成フラグをチェック
        if (this.autoGenerateVideo) {
            console.log('Starting automatic video generation...');
            try {
                const mainInstance = require('./tts-service');
                await mainInstance.makeVideo(null);
            } catch (error) {
                console.error('自動動画生成に失敗しました:', error);
            }
        }
    }

    async playAudio(datas, overlapDuration = 0, playbackSpeed = 1.0, autoGenerateVideo = false, options = {}) {
        this.playbackSpeed = playbackSpeed;
        this.autoGenerateVideo = autoGenerateVideo;
        this.videoFormat = normalizeVideoFormat(options?.videoFormat);
        const defaultLanguage = normalizeLanguage(options?.language);

        const list = [];
        for (let i = 0; i < datas.length; i++) {
            const data = datas[i] || {};
            const text = data.text;
            const speakerId = data.id;
            const mood = data.mood;
            const se = data.se;
            const effect = data.effect;
            const calloutText = typeof data.callout === 'string' ? data.callout.trim() : '';

            if (data.isSection || data.section) {
                console.log('Section detected in playAudio:', data.section);
                list.push({
                    isSection: true,
                    section: data.section,
                    text: '',
                    speakerId: 'section',
                    language: defaultLanguage,
                    duration: 2,
                    se: data.se
                });
                continue;
            }
            const entryLanguage = normalizeLanguage(data.language || defaultLanguage);
            let imagePath = null;
            const hasExplicitTime = data && Object.prototype.hasOwnProperty.call(data, 'time');
            const parsedTime = hasExplicitTime ? Number(data.time) : null;
            const requestedStartTime = (hasExplicitTime && Number.isFinite(parsedTime) && parsedTime >= 0)
                ? parsedTime
                : null;
            let isFirstSegment = true;
            let firstSegmentRef = null;
            let calloutAssigned = false;
            // callout が本文に含まれていない場合は「ラベル」として同一data内の全セグメントで表示し続ける
            // - （例: callout="Electric Callboyコラボ" / 本文に完全一致しない → 句点で分割されても消えない）
            // - タイプライターは最初のセグメントだけ実行し、2つ目以降は完成形を固定（ループ防止）
            const calloutLower = calloutText ? calloutText.toLowerCase() : '';
            const calloutIsLabel = !!calloutLower && (typeof text !== 'string' || !String(text).toLowerCase().includes(calloutLower));
            if (calloutIsLabel) {
                // マッチ/フォールバックで上書きされるのを防ぐ（ラベルは常に表示する）
                calloutAssigned = true;
            }
            const buildLabelCallout = (isFirst) => (
                calloutIsLabel
                    ? { text: calloutText, mode: (isFirst ? 'typewriter' : 'static') }
                    : null
            );

            if (typeof text !== 'string' || text.length === 0) {
                const rawVideoPath = (typeof data.insert_video === 'string') ? data.insert_video.trim() : data.insert_video;
                const videoPath = resolveProjectPath(rawVideoPath);
                if (typeof videoPath === 'string' && videoPath.trim().length > 0) {
                    const startValue = data.startTime || data.start_time || '00:00:00';
                    const endValue = data.endTime || data.end_time || startValue;
                    const startSeconds = parseTimecodeToSeconds(startValue);
                    const endSeconds = parseTimecodeToSeconds(endValue);
                    const durationSeconds = (Number.isFinite(startSeconds) && Number.isFinite(endSeconds))
                        ? Math.max(0, endSeconds - startSeconds)
                        : null;

                    if (!fs.existsSync(videoPath)) {
                        console.warn(`insert_video ファイルが存在しません: ${videoPath}`);
                    } else if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
                        console.warn(`insert_video の時間指定が不正です: start=${startValue}, end=${endValue}`);
                    } else {
                        list.push({
                            insertVideo: true,
                            path: videoPath,
                            videoStartOffset: startSeconds,
                            videoEndOffset: endSeconds,
                            duration: durationSeconds,
                            requestedStartTime,
                            startTime: startValue,
                            endTime: endValue,
                            language: entryLanguage,
                            effect: effect,
                            callout: calloutText || null
                        });
                    }
                }
                continue;
            }

            // 画像URLかローカルパスの処理
            if (data.img) {
                imagePath = await this._downloadAndSaveImage(data);
            }

            // videoPathプロパティの処理
            const resolvedVideoPath = (typeof data.videoPath === 'string') ? resolveProjectPath(data.videoPath.trim()) : null;
            const resolvedThumbnailPath = (typeof data.thumbnailPath === 'string') ? resolveProjectPath(data.thumbnailPath.trim()) : null;

            if (!imagePath && resolvedVideoPath && fs.existsSync(resolvedVideoPath)) {
                console.log(`動画ファイル処理: ${resolvedVideoPath}`);

                // サムネイルが既に生成されているか確認
                if (resolvedThumbnailPath && fs.existsSync(resolvedThumbnailPath)) {
                    imagePath = resolvedThumbnailPath;
                } else {
                    // サムネイルを生成
                    try {
                        const thumbnailResult = await this.generateThumbnailFromVideo(resolvedVideoPath);
                        if (thumbnailResult.success && thumbnailResult.thumbnailPath) {
                            imagePath = thumbnailResult.thumbnailPath;
                        } else {
                            // サムネイル生成失敗時は動画そのものを使用
                            imagePath = resolvedVideoPath;
                        }
                    } catch (error) {
                        console.error(`サムネイル生成エラー: ${error.message}`);
                        // エラー時は動画ファイルパスをそのまま使用
                        imagePath = resolvedVideoPath;
                    }
                }
            }

            // カッコで分割して処理
            // 正規表現: {{任意の文字}} をキャプチャ
            const parenRegex = /(\{\{.*?\}\})/g;
            const parts = text.split(parenRegex);

            for (const part of parts) {
                if (!part) continue;

                // カッコで囲まれているかチェック
                const isEcho = /^\{\{.*\}\}$/.test(part);
                // カッコを除去
                const cleanText = isEcho ? part.slice(2, -2) : part;

                if (!cleanText) continue;

                // 位置文字ずつバッファに追加
                let buffer = '';
                for (let j = 0; j < cleanText.length; j++) {
                    buffer += cleanText[j];

                    // 文末、改行、句読点、またはバッファが10文字以上で「、」がある場合に分割
                    const punctuationRegex = /[\n。？！]/;
                    const commaCondition = buffer.length >= 10 && cleanText[j] === '、';

                    // 現在の文字が区切り文字かチェック
                    if (punctuationRegex.test(cleanText[j]) || commaCondition) {
                        // 次の文字が区切り文字なら含める（最大10文字先まで確認）
                        let lookahead = 1;
                        const maxLookahead = Math.min(10, cleanText.length - j - 1);
                        const closingBrackets = /[）」』】\]\}>]/;

                        while (lookahead <= maxLookahead &&
                            (punctuationRegex.test(cleanText[j + lookahead]) ||
                                cleanText[j + lookahead] === '、' ||
                                closingBrackets.test(cleanText[j + lookahead]))) {
                            buffer += cleanText[j + lookahead];
                            lookahead++;
                        }

                        // 先読みした分だけインデックスを進める
                        j += (lookahead - 1);

                        // imagePathを含めてlistに追加（句読点や改行記号を含めて追加）
                        const segment = {
                            text: buffer,
                            speakerId,
                            imagePath,
                            callout: buildLabelCallout(isFirstSegment),
                            mood,
                            language: entryLanguage,
                            isEcho: isEcho,
                            se: isFirstSegment ? se : null,
                            effect: effect
                        };
                        if (isFirstSegment && requestedStartTime !== null) {
                            segment.requestedStartTime = requestedStartTime;
                        }
                        if (!firstSegmentRef && calloutText) {
                            firstSegmentRef = segment;
                        }
                        if (!calloutAssigned && calloutText) {
                            const haystack = String(buffer || '').toLowerCase();
                            const needle = calloutText.toLowerCase();
                            if (needle && haystack.includes(needle)) {
                                segment.callout = calloutText;
                                calloutAssigned = true;
                            }
                        }
                        list.push(segment);
                        isFirstSegment = false;
                        buffer = '';
                    }
                }

                // 残りのテキストがある場合も追加
                if (buffer.length > 0) {
                    const segment = {
                        text: buffer,
                        speakerId,
                        imagePath,
                        callout: buildLabelCallout(isFirstSegment),
                        mood,
                        language: entryLanguage,
                        isEcho: isEcho,
                        se: isFirstSegment ? se : null,
                        effect: effect
                    };
                    if (isFirstSegment && requestedStartTime !== null) {
                        segment.requestedStartTime = requestedStartTime;
                    }
                    if (!firstSegmentRef && calloutText) {
                        firstSegmentRef = segment;
                    }
                    if (!calloutAssigned && calloutText) {
                        const haystack = String(buffer || '').toLowerCase();
                        const needle = calloutText.toLowerCase();
                        if (needle && haystack.includes(needle)) {
                            segment.callout = calloutText;
                            calloutAssigned = true;
                        }
                    }
                    list.push(segment);
                    isFirstSegment = false; // Ensure subsequent parts are not first
                }
            }

            // callout がどのセグメントにもマッチしなかった場合は、最初のセグメントにフォールバックで付与
            if (calloutText && !calloutAssigned && firstSegmentRef) {
                firstSegmentRef.callout = calloutText;
            }
        }

        // 音声生成
        await this.generateAudio(list);

        // 生成後にタイムライン情報を補完
        this.lastOverlapDuration = overlapDuration;
        await this._ensureAudioMetadata(overlapDuration);


        // 音声再生
        this.isActive = true;
        this.currentPlayingProgress = 0;

        for (let i = 0; i < this.audioFiles.length; i++) {

            this.currentPlayingAudioFile = this.audioFiles[i];
            this.currentPlayingProgress = i / this.audioFiles.length;

            if (this.currentPlayingAudioFile && this.currentPlayingAudioFile.insertVideo) {
                continue;
            }

            if (this.currentPlayingAudioFile && this.currentPlayingAudioFile.isSection) {
                const duration = this.currentPlayingAudioFile.duration || 1;
                await new Promise(resolve => setTimeout(resolve, duration * 1000));
                continue;
            }

            await this._playAudio(this.currentPlayingAudioFile, overlapDuration)


            // スキップ処理
            if (this.isSkipping) {
                this.isSkipping = false;
                i += this.skipCount;
                if (i < -1) { i = -1; }
                if (i >= this.audioFiles.length) { return; }
                this.skipCount = 0;

                // 一時停止中は待機
                while (this.isPause && this.isActive) {
                    await new Promise(resolve => setTimeout(resolve, 100));
                }

                if (!this.isActive) return;
            }

            if (!this.isActive) return;
        }

        // 最後に100%に設定
        this.currentPlayingProgress = 1;
    }

    async stopAudio() {
        if (!this.isActive) return;

        this.isActive = false;
        this.currentPlayingProgress = 0;
        this.generateAudioProgress = 0;

        for (let i = 0; i < this.audioFiles.length; i++) {
            const audioFile = this.audioFiles[i];
            try {
                if (audioFile.player) {
                    audioFile.player.kill();
                }

                // Clean up downloaded image
                if (audioFile.imagePath && fs.existsSync(audioFile.imagePath)) {
                    try {
                        fs.unlinkSync(audioFile.imagePath);
                        console.log(`Deleted image file: ${audioFile.imagePath}`);
                    } catch (error) {
                        console.error(`画像ファイルの削除に失敗しました (${audioFile.imagePath}):`, error);
                    }
                }
            } catch (error) {
                console.error('音声ファイルの削除または関連ファイルのクリーンアップに失敗しました:', error);
            }
        }
        this.audioFiles = []; // Clear the array after cleanup
    }

    _killAllPlayers() {
        for (let i = 0; i < this.audioFiles.length; i++) {
            const audioFile = this.audioFiles[i];
            if (audioFile.player) {
                try {
                    audioFile.player.kill();
                } catch (error) {
                    console.error('音声ファイルの終了に失敗しました:', error);
                }
            }
        }
    }

    async pauseAudio() {
        this.isPause = true;
        this.isSkipping = true;
        this.skipCount -= 1;
        this._killAllPlayers();
    }

    async resumeAudio() {
        this.isPause = false;
    }

    async nextAudio() {
        this.isSkipping = true;
        this.skipCount = 0;
        this._killAllPlayers();

    }

    async prevAudio() {
        this.isSkipping = true;
        this.skipCount -= 2;
        this._killAllPlayers();
    }

    async restartAudio() {
        this.isSkipping = true;
        this.skipCount -= this.audioFiles.length;
        this._killAllPlayers();

        console.log('restartAudio', this.skipCount);
    }

    async changePlaybackSpeed(newSpeed) {
        this.playbackSpeed = newSpeed;
        this.isSkipping = true;
        this.skipCount -= 1;
        this._killAllPlayers();
    }

    async uploadToYoutube(videoPath, onProgress) {

        const uploader = this._getYoutubeUploader();
        await uploader.authenticate();
        await uploader.uploadVideo({
            videoPath: videoPath,
            title: this.youtubeInfo.title,
            description: this.youtubeInfo.description,
            tags: this.youtubeInfo.tags,
            categoryId: this.youtubeInfo.categoryId || "22",
            thumbnailPath: this.youtubeInfo.thumbnailPath
        }, (progress) => {
            if (onProgress) {
                onProgress(progress);
            }
        });
    }

    _getYoutubeUploader() {
        const configDir = getYoutubeConfigDir();
        if (!this.youtubeUploader) {
            this.youtubeUploader = new YouTubeUploader(this.youtubeTokenFile, { configDir });
        } else {
            if (typeof this.youtubeUploader.setConfigDir === 'function') {
                this.youtubeUploader.setConfigDir(configDir);
            }
            this.youtubeUploader.setTokenFileName(this.youtubeTokenFile);
        }
        return this.youtubeUploader;
    }

    async makeVideo(backgroundPath = null, onVideoProgress, onUploadProgress) {
        const videoProgressCb = (typeof onVideoProgress === 'function') ? onVideoProgress : null;
        const uploadProgressCb = (typeof onUploadProgress === 'function') ? onUploadProgress : null;

        // 進捗表示の初期化（呼び出し元がTTSServiceMainでないケースもあるため）
        if (videoProgressCb) {
            try { videoProgressCb(0); } catch (_) { /* ignore */ }
        }

        this.outputPath = await this._makeVideo(backgroundPath, videoProgressCb || undefined);

        // SRTは YouTubeアップロード有無に関わらず出力する（autoUploadの判定前）
        let srtPath = null;
        try {
            const overlap = (typeof this.lastOverlapDuration === 'number' && isFinite(this.lastOverlapDuration) && this.lastOverlapDuration >= 0)
                ? this.lastOverlapDuration
                : 0;
            srtPath = await this.writeCaptionsSrt(overlap);
        } catch (_) { /* 失敗しても再生処理は継続 */ }

        if (this.autoUploadToYoutube) {
            // YouTubeへアップロードする場合のみ、SRTからチャプター生成（説明文に追記）
            try {
                await this.generateYoutubeChaptersFromCaptionsSrt(srtPath);
            } catch (_) { /* 失敗しても再生処理は継続 */ }
            if (uploadProgressCb) {
                try { uploadProgressCb(0); } catch (_) { /* ignore */ }
            }
            await this.uploadToYoutube(this.outputPath, uploadProgressCb || undefined);
        }

        if (videoProgressCb) {
            try { videoProgressCb(1); } catch (_) { /* ignore */ }
        }
        return this.outputPath;
    }

    async _makeVideo(backgroundPath = null, onProgress) {
        if (!this.audioFiles.length) return null;

        const metadataOverlap = (typeof this.lastOverlapDuration === 'number' && this.lastOverlapDuration >= 0)
            ? this.lastOverlapDuration
            : 0;
        await this._ensureAudioMetadata(metadataOverlap);

        // 全体のパフォーマンスログを開始
        const totalTimer = performanceLogger.startTimer('makeVideo_total');
        performanceLogger.addLog('makeVideo_start', {
            audioFilesCount: this.audioFiles.length,
            playbackSpeed: this.playbackSpeed,
            backgroundPath: backgroundPath || 'default'
        });

        console.log('Starting video creation process...');
        console.log(`Processing ${this.audioFiles.length} audio files`);
        console.log(`Playback speed: ${this.playbackSpeed}x`);

        // 先に各音声ファイルの長さを取得
        const durationTimer = performanceLogger.startTimer('getAudioDurations');
        console.log('Getting audio durations...');

        const audioFilesWithDuration = [];
        for (const file of this.audioFiles) {
            if (!file) continue;
            if (!file.isSection && (!file.path || !fs.existsSync(file.path))) {
                continue;
            }

            const rawText = String(file.text || '');
            const lines = [];
            let textWalker = rawText;
            while (textWalker.length > 0) {
                lines.push(textWalker.slice(0, 25));
                textWalker = textWalker.slice(25);
            }

            let duration = (typeof file.duration === 'number' && isFinite(file.duration) && file.duration >= 0)
                ? file.duration
                : null;
            if (duration === null) {
                if (file.isSection) {
                    duration = 1;
                } else {
                    duration = await this.getAudioDuration(file.path);
                }
                if (typeof duration === 'number' && isFinite(duration) && duration >= 0) {
                    file.duration = duration;
                } else {
                    duration = 0;
                    file.duration = 0;
                }
            }

            let startTime = (typeof file.startTime === 'number' && isFinite(file.startTime) && file.startTime >= 0)
                ? file.startTime
                : null;
            if (startTime === null) {
                const last = audioFilesWithDuration[audioFilesWithDuration.length - 1];
                if (last && typeof last.startTime === 'number' && typeof last.duration === 'number') {
                    startTime = Math.max(0, last.startTime + last.duration);
                } else {
                    startTime = 0;
                }
                file.startTime = startTime;
            }

            if (file.insertVideo) {
                audioFilesWithDuration.push({
                    ...file,
                    text: '',
                    duration,
                    startTime
                });
                continue;
            }

            if (file.isSection) {
                audioFilesWithDuration.push({
                    ...file,
                    text: '',
                    duration: file.duration || 1,
                    startTime,
                    se: file.se
                });
                continue;
            }

            console.log(`オリジナル音声: ${file.path}, 長さ: ${duration}秒, 開始: ${startTime}秒, テキスト: "${rawText.substring(0, 30)}${rawText.length > 30 ? '...' : ''}"`);

            audioFilesWithDuration.push({
                ...file,
                text: lines.join('\n'),
                duration,
                startTime
            });
        }

        audioFilesWithDuration.sort((a, b) => {
            const aStart = (typeof a.startTime === 'number' && isFinite(a.startTime)) ? a.startTime : 0;
            const bStart = (typeof b.startTime === 'number' && isFinite(b.startTime)) ? b.startTime : 0;
            if (aStart === bStart) return 0;
            return aStart < bStart ? -1 : 1;
        });

        durationTimer.end({ audioFilesCount: audioFilesWithDuration.length });

        fs.writeFileSync(TEMP_DIR + '/audioFiles.json', JSON.stringify(audioFilesWithDuration, null, 2));

        // ファイル名を安全な形式に変換
        let outputFileName = this?.youtubeInfo?.title || `output-${Date.now()}`;
        // 特殊文字や日本語などを除去し、安全なファイル名にする
        outputFileName = outputFileName
            .replace(/[^\w\s.-]/g, '_')  // 英数字、スペース、ピリオド、ハイフン以外を_に置換
            .replace(/\s+/g, '_')        // スペースを_に置換
            .replace(/__+/g, '_')        // 連続する_を単一の_に置換
            .substr(0, 100);             // 長すぎるファイル名を切り詰める

        // 拡張子を .mp4 にする
        const outputPath = path.join(TEMP_DIR, `${outputFileName}.mp4`);

        console.log(`Output will be saved to: ${outputPath}`);

        let videoClips = []; // Declare here to be accessible in catch block
        return new Promise(async (resolve, reject) => {
            try {
                this.clipsAdjustedForSpeed = false;

                // 動画クリップ情報を収集
                const ttsMain = require('./tts-service');
                const defaultBgPath = fs.existsSync(TEMP_BG_PATH) ? TEMP_BG_PATH : null;
                const gapBackgroundPath = (backgroundPath && fs.existsSync(backgroundPath)) ? backgroundPath : defaultBgPath;
                let lastGapBackgroundPath = gapBackgroundPath;

                // 動画クリップの情報を準備
                const videoClips = [];

                // 各スピーカーの動画ファイルを確認
                const speakerVideos = {};

                // Load speaker ID mapping
                let speakerMapping = {};
                try {
                    const mappingPath = path.join(getAssetsPath(), 'data', 'tts-service-en.json');
                    if (fs.existsSync(mappingPath)) {
                        speakerMapping = JSON.parse(fs.readFileSync(mappingPath, 'utf8'));
                    }
                } catch (e) {
                    console.error('Failed to load TTS mapping:', e);
                }

                // まずスピーカーごとの動画ファイルを確認
                // ムードごとにキャッシュ（speakerId + mood）
                for (const file of audioFilesWithDuration) {
                    const cacheKey = `${file.speakerId}__${file.mood || ''}`;
                    if (!speakerVideos[cacheKey]) {
                        let speakerIdForVideo = file.speakerId;

                        // Check mapping
                        if (speakerMapping[speakerIdForVideo]) {
                            speakerIdForVideo = speakerMapping[speakerIdForVideo];
                        }

                        const videoPath = ttsMain.getSpeakerVideoPath(speakerIdForVideo, file.mood);
                        if (videoPath) {
                            speakerVideos[cacheKey] = videoPath;
                            console.log(`スピーカー ${file.speakerId}${file.mood ? ` (${file.mood})` : ''} の動画: ${videoPath}`);
                        } else {
                            console.warn(`スピーカー ${file.speakerId}${file.mood ? ` (${file.mood})` : ''} の動画が見つからないためスキップします。`);
                            speakerVideos[cacheKey] = null;
                        }
                    }
                }

                // 冒頭に背景動画を追加（introBgVideo が未指定/空の場合はスキップ）
                const introBgVideoPath = (typeof this.introBgVideoPath === 'string' && this.introBgVideoPath.trim())
                    ? this.introBgVideoPath.trim()
                    : null;

                if (introBgVideoPath) {
                    const introClipTimer = performanceLogger.startTimer('createIntroClip');
                    const introClipPath = path.join(TEMP_DIR, `clip_intro_${Date.now()}.mkv`);
                    const ext = path.extname(introBgVideoPath).toLowerCase();
                    const isVideo = VIDEO_EXTENSIONS.has(ext);
                    const introDuration = isVideo
                        ? await getVideoDuration(introBgVideoPath)
                        : 2;
                    this.introClipDuration = introDuration;
                    await this._createIntroClip(introBgVideoPath, introClipPath, introDuration, { isVideo });
                    introClipTimer.end({ clipPath: introClipPath });
                    videoClips.push(introClipPath);
                } else {
                    this.introClipDuration = 0;
                }

                // クリップ作成開始時間を記録
                const clipsStartTime = Date.now();

                // 背景動画の再生位置をトラッキングする累積オフセット
                let backgroundTimeOffset = 0;

                // 現在の背景画像パスをトラッキング
                let currentImagePath = null;

                // タイムラインの進行状況（イントロ終了直後を0とする）
                let timelineCursor = 0;

                // ズーム状態のトラッキング
                let currentZoom = 1.0;
                let lastSpeakerIdForZoom = null;
                let lastWasZoomClip = false;

                // 各音声ファイルごとに動画クリップを生成
                for (let i = 0; i < audioFilesWithDuration.length; i++) {
                    const clipTimer = performanceLogger.startTimer('createClip');

                    const file = audioFilesWithDuration[i];
                    performanceLogger.addLog('createClip_start', {
                        clipIndex: i,
                        audioPath: file.path,
                        text: file.text?.substring(0, 30) + (file.text?.length > 30 ? '...' : '')
                    });

                    if (file.insertVideo) {
                        const insertClipPath = path.join(TEMP_DIR, `clip_insert_${i}_${Date.now()}.mkv`);
                        const insertClipResult = await this._createInsertedVideoClip(
                            file,
                            insertClipPath,
                            defaultBgPath,
                            (progress) => {
                                if (onProgress) onProgress(progress * 0.6);
                            }
                        );
                        clipTimer.end({
                            clipIndex: i,
                            originalDuration: file.duration,
                            adjustedDuration: file.duration,
                            effectiveDuration: insertClipResult.duration,
                            clipPath: insertClipResult.outputPath,
                            backgroundTimeOffset,
                            clipStartTime: file.startTime
                        });
                        videoClips.push(insertClipResult.outputPath);
                        backgroundTimeOffset += insertClipResult.duration;
                        timelineCursor = Math.max(timelineCursor, file.startTime) + insertClipResult.duration;
                        continue;
                    }

                    if (file.isSection) {
                        console.log('Creating section clip for video:', file.section);
                        const sectionClipPath = path.join(TEMP_DIR, `clip_section_${i}_${Date.now()}.mkv`);
                        const duration = file.duration || 1;
                        await this._createSectionClip(file.section, sectionClipPath, duration, file.se);
                        videoClips.push(sectionClipPath);

                        backgroundTimeOffset += duration;
                        timelineCursor = Math.max(timelineCursor, file.startTime) + duration;
                        continue;
                    }

                    const originalDuration = file.duration;
                    const speed = (typeof this.playbackSpeed === 'number' && this.playbackSpeed > 0)
                        ? this.playbackSpeed
                        : 1.0;
                    const adjustedDuration = originalDuration / speed;

                    console.log(`[DEBUG][詳細] 音声ファイル${i + 1}: ${file.path}`);
                    console.log(`[DEBUG][詳細] 元の長さ: ${originalDuration}秒, 再生速度: ${speed}x, 調整後長さ: ${adjustedDuration}秒`);
                    console.log(`[DEBUG][詳細] 背景動画開始位置: ${backgroundTimeOffset}秒`);

                    const clipStartTime = (typeof file.startTime === 'number' && isFinite(file.startTime) && file.startTime >= 0)
                        ? file.startTime
                        : timelineCursor;
                    const gapDuration = clipStartTime - timelineCursor;
                    if (gapDuration > 0.01) {
                        const gapClipPath = path.join(TEMP_DIR, `clip_gap_${i}_${Date.now()}.mkv`);
                        console.log(`[DEBUG][詳細] ギャップ ${gapDuration}秒 を埋める無音クリップを生成します (${gapClipPath})`);
                        const gapVisualPath = (currentImagePath && fs.existsSync(currentImagePath))
                            ? currentImagePath
                            : (lastGapBackgroundPath && fs.existsSync(lastGapBackgroundPath))
                                ? lastGapBackgroundPath
                                : gapBackgroundPath;
                        await this._createGapClip(gapDuration, gapClipPath, {
                            backgroundPath: gapVisualPath,
                            fallbackBackground: gapBackgroundPath,
                            backgroundOffset: backgroundTimeOffset
                        });
                        lastGapBackgroundPath = gapVisualPath;
                        videoClips.push(gapClipPath);
                        timelineCursor += gapDuration;
                        backgroundTimeOffset += gapDuration;
                    } else if (gapDuration < -0.01) {
                        console.warn(`[WARN] クリップの開始時刻 (${clipStartTime}s) が現在のタイムライン(${timelineCursor}s)より早いため、重なりが発生します。`);
                    } else {
                        timelineCursor = Math.max(timelineCursor, clipStartTime);
                    }

                    let videoPath = speakerVideos[`${file.speakerId}__${file.mood || ''}`];
                    let useZoom = false;
                    let isStaticClip = false;

                    // ズームの連続性チェック
                    let isContinuousZoom = (file.speakerId === lastSpeakerIdForZoom) && lastWasZoomClip;
                    if (!isContinuousZoom) {
                        currentZoom = 1.0;
                    }

                    // SEがある場合の先行クリップ生成処理
                    if (file.se) {
                        const sePath = path.join(getAssetsPath(), 'se', file.se);
                        if (fs.existsSync(sePath)) {
                            console.log(`[DEBUG] SE先行クリップ生成: ${file.se}`);

                            // SEの長さを取得
                            let seDuration = 0;
                            try {
                                seDuration = await this.getAudioDuration(sePath);
                            } catch (e) {
                                console.error('SE duration check failed:', e);
                                seDuration = 1;
                            }
                            if (!seDuration || seDuration < 1) seDuration = 1;

                            // 静止画（サムネイル）を取得して使用
                            let staticImagePath = null;
                            if (videoPath) {
                                const lower = videoPath.toLowerCase();
                                const isVideo = lower.endsWith('.mp4') || lower.endsWith('.mov') || lower.endsWith('.mkv') || lower.endsWith('.avi');
                                if (isVideo) {
                                    try {
                                        // TTSServiceMainのメソッドを使うため require
                                        const ttsMain = require('./tts-service');
                                        const thumb = await ttsMain.generateThumbnailFromVideo(videoPath);
                                        if (thumb.success && thumb.thumbnailPath) {
                                            staticImagePath = thumb.thumbnailPath;
                                        }
                                    } catch (e) {
                                        console.warn(`SE用サムネイル生成失敗: ${e.message}`);
                                    }
                                } else {
                                    staticImagePath = videoPath;
                                }
                            }
                            if (!staticImagePath && gapBackgroundPath && fs.existsSync(gapBackgroundPath)) {
                                staticImagePath = gapBackgroundPath;
                            }

                            if (staticImagePath) {
                                const seClipPath = path.join(TEMP_DIR, `clip_se_${i}_${Date.now()}.mkv`);
                                console.log(`[DEBUG] SEクリップ作成: ${seClipPath}, duration=${seDuration}, startZoom=${currentZoom}`);

                                const seClipResult = await this._createVideoClipWithText(
                                    staticImagePath,
                                    file.text,
                                    sePath, // Audio is SE
                                    file.imagePath,
                                    seClipPath,
                                    seDuration,
                                    0, // Static image, no offset needed
                                    false,
                                    true,
                                    false,
                                    null, // SE is passed as main audio
                                    file.effect,
                                    true, // useZoom = true
                                    currentZoom, // initialZoom
                                    file.language, // language (ja/en)
                                    null // callout (SE先行クリップでは表示しない)
                                );

                                videoClips.push(seClipResult.outputPath || seClipPath);
                                timelineCursor += (seClipResult.duration || seDuration);

                                // ズーム状態を更新
                                currentZoom = seClipResult.finalZoom || currentZoom;
                                lastSpeakerIdForZoom = file.speakerId;
                                lastWasZoomClip = true;
                                isContinuousZoom = true; // 次のメインクリップのために連続フラグを立てる
                            }
                        } else {
                            console.warn(`SEファイルが見つからないためスキップします: ${sePath}`);
                        }
                    }

                    // エコー（カッコ内テキスト）の場合は動画を停止（静止画化）する
                    if (file.isEcho) {
                        console.log(`[DEBUG][ECHO_LOG] エコー判定(TRUE) テキスト: "${file.text}"`);
                        console.log(`[DEBUG][ECHO_LOG] 現在の videoPath: ${videoPath}`);

                        if (videoPath) {
                            const lower = videoPath.toLowerCase();
                            const isVideo = lower.endsWith('.mp4') || lower.endsWith('.mov') || lower.endsWith('.mkv') || lower.endsWith('.avi');
                            console.log(`[DEBUG][ECHO_LOG] 動画判定(拡張子): ${isVideo}`);

                            if (isVideo) {
                                try {
                                    console.log(`[DEBUG][ECHO_LOG] サムネイル生成開始...`);
                                    const ttsMain = require('./tts-service');
                                    const thumb = await ttsMain.generateThumbnailFromVideo(videoPath);
                                    console.log(`[DEBUG][ECHO_LOG] サムネイル生成結果: success=${thumb.success}, path=${thumb.thumbnailPath}`);

                                    if (thumb.success && thumb.thumbnailPath) {
                                        console.log(`[DEBUG][ECHO_LOG] 置き換え実行: ${videoPath} -> ${thumb.thumbnailPath}`);
                                        videoPath = thumb.thumbnailPath;
                                        isStaticClip = true;
                                    } else {
                                        console.warn(`[WARN][ECHO_LOG] エコー用静止画生成失敗: ${thumb.error}`);
                                    }
                                } catch (e) {
                                    console.warn(`[WARN][ECHO_LOG] エコー用静止画生成例外: ${e.message}`);
                                }
                            } else {
                                console.log(`[DEBUG][ECHO_LOG] すでに動画ではないファイルです: ${videoPath}`);
                                isStaticClip = true;
                            }
                        } else {
                            console.log(`[DEBUG][ECHO_LOG] videoPath が存在しません`);
                        }

                        // エコーの場合はズームを有効化
                        useZoom = true;
                    } else {
                        // エコーでない場合のログ（デバッグ用、量が多ければ後で削除）
                        // console.log(`[DEBUG][ECHO_LOG] エコー判定(FALSE) テキスト: "${file.text}"`);
                    }

                    const imagePath = file.imagePath; // Get imagePath from the file object

                    // クリップ情報を準備
                    const clipPath = path.join(TEMP_DIR, `clip_${i}_${Date.now()}.mkv`);

                    // 音声の再生速度に合わせた長さでクリップを生成（背景は常に1.0x）
                    const clipDuration = (i === audioFilesWithDuration.length - 1)
                        ? (adjustedDuration + 0.4) // 最後のクリップのみ安全マージンとして+0.4秒
                        : adjustedDuration;
                    console.log(`[DEBUG][詳細] クリップ作成時に ${clipDuration}秒 (背景は1.0xで進行、音声速度反映) の長さを使用`);
                    console.log(`[DEBUG][詳細] 背景動画パス: ${videoPath || 'なし'}`);
                    console.log(`[DEBUG][詳細] 背景はビデオ？: ${videoPath && (
                        videoPath.toLowerCase().endsWith('.mp4') ||
                        videoPath.toLowerCase().endsWith('.mov') ||
                        videoPath.toLowerCase().endsWith('.avi')
                    )}`);

                    // 前のビデオパスと異なる場合はオフセットをリセット
                    if (i > 0 && imagePath !== currentImagePath) {
                        console.log(`[DEBUG][詳細] 背景動画が変更されました。オフセットをリセットします。`);
                        backgroundTimeOffset = 0;

                        performanceLogger.addLog('backgroundTimeOffset', {
                            videoPath: videoPath,
                            imagePath: imagePath,
                            backgroundTimeOffset: backgroundTimeOffset,
                            speakerId: this.audioFiles[i - 1].speakerId
                        });
                    }

                    // 現在の背景画像パスを更新
                    currentImagePath = imagePath;
                    lastGapBackgroundPath = (imagePath && fs.existsSync(imagePath))
                        ? imagePath
                        : (videoPath && fs.existsSync(videoPath))
                            ? videoPath
                            : gapBackgroundPath;

                    // 背景/サムネイル/スピーカー動画が無い場合は、生成済みの背景（current-bg.png）があればそれを使う
                    if (!imagePath && !videoPath && gapBackgroundPath && fs.existsSync(gapBackgroundPath)) {
                        videoPath = gapBackgroundPath;
                    }

                    // テキストオーバーレイと合わせて動画クリップを作成 (背景オフセットを追加)
                    const clipResult = await this._createVideoClipWithText(
                        videoPath,
                        file.text,
                        file.path, // 音声ファイル
                        imagePath, // Pass the image path
                        clipPath,
                        clipDuration,
                        (imagePath && imagePath.length > 0) ? backgroundTimeOffset : 0, // 背景動画の開始位置
                        true,
                        true,
                        (i === audioFilesWithDuration.length - 1), // 最終クリップのみ音声を+1秒パディング
                        file.se ? null : file.se, // SEは先行クリップで再生済みならnullにする
                        file.effect,
                        useZoom,
                        currentZoom, // initialZoom
                        file.language, // language (ja/en)
                        file.callout
                    );
                    const effectiveClipDuration = (clipResult && typeof clipResult.duration === 'number' && isFinite(clipResult.duration) && clipResult.duration > 0)
                        ? clipResult.duration
                        : adjustedDuration;
                    const createdClipPath = (clipResult && clipResult.outputPath) ? clipResult.outputPath : clipPath;

                    // ズーム状態の更新
                    if (useZoom) {
                        currentZoom = clipResult.finalZoom || currentZoom;
                        lastSpeakerIdForZoom = file.speakerId;
                        lastWasZoomClip = true;
                    } else {
                        // ズームしないクリップ（通常の動画など）の場合はリセット
                        currentZoom = 1.0;
                        lastSpeakerIdForZoom = file.speakerId;
                        lastWasZoomClip = false;
                    }

                    clipTimer.end({
                        clipIndex: i,
                        originalDuration,
                        adjustedDuration,
                        effectiveDuration: effectiveClipDuration,
                        clipPath: createdClipPath,
                        backgroundTimeOffset,
                        clipStartTime
                    });

                    videoClips.push(createdClipPath);

                    // 次クリップの背景オフセットを更新
                    // 静止画クリップ（エコーなど）の場合は背景動画を進めない
                    if (!isStaticClip) {
                        backgroundTimeOffset += effectiveClipDuration;
                    }
                    timelineCursor = Math.max(timelineCursor, clipStartTime) + effectiveClipDuration;
                }

                const finalTimelineDuration = timelineCursor;

                performanceLogger.addLog('finishCreatingClips', {
                    clipsCount: videoClips.length - 1, // イントロを除く
                    totalDuration: Date.now() - clipsStartTime,
                    totalDuration_readable: performanceLogger.formatDuration(Date.now() - clipsStartTime),
                    playbackTimelineSeconds: finalTimelineDuration
                });

                // すべての動画クリップを連結して最終動画を作成
                const concatTimer = performanceLogger.startTimer('concatenateClips');
                performanceLogger.addLog('startConcatenating', { clipCount: videoClips.length });

                const temporaryConcatOutput = path.join(TEMP_DIR, `concatenated_${Date.now()}.mkv`);
                const finalVideo = await this._concatenateClips(videoClips, temporaryConcatOutput, progress => {
                    if (onProgress) onProgress(progress * 0.6); // 連結は進捗の0-60%を占める
                });

                concatTimer.end({ finalVideo });

                // *** ADD LOGGING HERE ***
                console.log(`[DEBUG] Concatenated video should be created at: ${finalVideo}`);
                if (fs.existsSync(finalVideo)) {
                    console.log(`[DEBUG] File exists check PASSED for: ${finalVideo}`);
                } else {
                    console.error(`[DEBUG] File exists check FAILED for: ${finalVideo} immediately after concatenation!`);
                }
                // *** END LOGGING ***

                // BGMを追加（未指定/存在しない場合はスキップ）
                const originalDuration = (this.introClipDuration || 0) + finalTimelineDuration;

                let videoWithBgm = finalVideo;
                if (this.currentBgmPath && fs.existsSync(this.currentBgmPath)) {
                    console.log(`[DEBUG] BGM追加 - 全体の長さ: ${originalDuration}秒 (再生速度反映後)`);
                    console.log(`[DEBUG] Preparing to add BGM to: ${finalVideo}`);
                    if (!fs.existsSync(finalVideo)) {
                        console.error(`[DEBUG] File exists check FAILED for: ${finalVideo} right before adding BGM!`);
                    }

                    const bgmTimer = performanceLogger.startTimer('addBgmToVideo');
                    const losslessOutputPath = path.join(TEMP_DIR, `final_lossless_${Date.now()}.mkv`);
                    videoWithBgm = await this._addBgmToVideo(finalVideo, losslessOutputPath, originalDuration, progress => {
                        if (onProgress) onProgress(0.6 + progress * 0.2); // BGM追加は進捗の60-80%を占める
                    });
                    bgmTimer.end({ videoWithBgm });
                } else if (this.currentBgmPath) {
                    console.warn(`BGMファイルが見つからないためスキップします: ${this.currentBgmPath}`);
                } else {
                    console.log('[DEBUG] BGM未設定のためスキップします');
                }

                // 最終的なMP4へのエンコード
                const encodeTimer = performanceLogger.startTimer('encodeVideo');
                const finalMP4 = await this._encodeVideo(videoWithBgm, outputPath, progress => {
                    if (onProgress) onProgress(0.8 + progress * 0.2); // エンコードは進捗の80-100%を占める
                });
                encodeTimer.end({ finalMP4 });

                // 一時ファイルの削除
                // if (fs.existsSync(finalVideo) && finalVideo !== outputPath) {
                //     try { fs.unlinkSync(finalVideo); } catch (e) { console.error(`一時ファイル削除エラー: ${finalVideo}`, e); }
                // }
                if (fs.existsSync(videoWithBgm) && videoWithBgm !== outputPath) {
                    try { fs.unlinkSync(videoWithBgm); } catch (e) { console.error(`一時ファイル削除エラー: ${videoWithBgm}`, e); }
                }

                // Clean up temporary images
                for (const file of this.audioFiles) {
                    if (file.imagePath && fs.existsSync(file.imagePath)) {
                        try { fs.unlinkSync(file.imagePath); } catch (e) { console.error(`一時画像削除エラー: ${file.imagePath}`, e); }
                    }
                }

                // トータルタイマー終了の前にこのコードを追加
                const qualityInfo = await this._getVideoQualityInfo(finalMP4);

                // 全体のパフォーマンスログを終了して保存
                totalTimer.end({
                    outputPath: finalMP4,
                    videoSize: fs.statSync(finalMP4).size,
                    qualityInfo: qualityInfo  // 品質情報を追加
                });

                // ログを保存
                performanceLogger.saveLogs({
                    videoInfo: {
                        outputPath: finalMP4,
                        duration: originalDuration,
                        clipsCount: videoClips.length,
                        playbackSpeed: this.playbackSpeed,
                        qualityInfo: qualityInfo  // 品質情報を追加
                    }
                });

                resolve(finalMP4);
            } catch (error) {
                console.error('動画生成エラー:', error);

                // エラー情報を含めてログを保存
                performanceLogger.addLog('makeVideo_error', {
                    error: error.message,
                    stack: error.stack
                });
                performanceLogger.saveLogs({ error: error.message });

                // Clean up temporary clips on error
                for (const clipPath of videoClips) { // Use the outer scope variable
                    if (fs.existsSync(clipPath)) {
                        try { fs.unlinkSync(clipPath); } catch (e) { console.error(`一時クリップ削除エラー: ${clipPath}`, e); }
                    }
                }
                // Clean up temporary images on error
                for (const file of this.audioFiles) {
                    if (file.imagePath && fs.existsSync(file.imagePath)) {
                        try { fs.unlinkSync(file.imagePath); } catch (e) { console.error(`一時画像削除エラー: ${file.imagePath}`, e); }
                    }
                }
                reject(error);
            }
        });
    }

    async _createSectionClip(text, outputPath, duration, seFileName) {
        const layout = getVideoLayout(this.videoFormat);
        const extent = `${layout.width}x${layout.height}`;
        // 1700/1920 ≒ 0.885（従来の横長設定に合わせた比率）
        const captionWidth = Math.max(1, Math.floor(layout.width * 0.885));
        const fontPath = getFontPath('NotoSansJP-Black.ttf');
        const safeDuration = Number(duration) || 1;

        return new Promise((resolve, reject) => {
            const imagePath = path.join(TEMP_DIR, `section_bg_${Date.now()}.png`);
            // Black background, white text, centered, with wrapping and padding
            const command = `"${MAGICK_BIN}" -background black -fill white -font "${fontPath}" -pointsize 100 -size ${captionWidth}x caption:"${text}" -gravity center -extent ${extent} "${imagePath}"`;

            exec(command, (err) => {
                if (err) {
                    console.error('Section image creation failed:', err);
                    reject(err);
                    return;
                }

                const sePath = seFileName ? path.join(getAssetsPath(), 'se', seFileName) : null;
                const hasSe = sePath && fs.existsSync(sePath);
                if (seFileName && !hasSe) {
                    console.warn(`SEファイルが見つからないためスキップします: ${sePath}`);
                }

                let ffmpegCommand = ffmpeg(imagePath)
                    .loop(safeDuration)
                    .inputOptions(['-t', `${safeDuration}`]);

                if (hasSe) {
                    console.log(`Adding SE to section clip: ${sePath}`);
                    ffmpegCommand = ffmpegCommand.input(sePath);
                } else {
                    ffmpegCommand = ffmpegCommand.input('anullsrc=channel_layout=stereo:sample_rate=44100')
                        .inputOptions(['-f', 'lavfi']);
                }

                ffmpegCommand
                    .outputOptions([
                        '-t', `${safeDuration}`,
                        '-c:v', 'libx264',
                        '-pix_fmt', 'yuv420p',
                        '-c:a', 'aac',
                        '-shortest'
                    ])
                    .save(outputPath)
                    .on('end', () => {
                        try { fs.unlinkSync(imagePath); } catch (e) { }
                        resolve(outputPath);
                    })
                    .on('error', (err) => {
                        reject(err);
                    });
            });
        });
    }

    async _createGapClip(duration, outputPath, options = {}) {
        const safeDuration = Number(duration);
        if (!isFinite(safeDuration) || safeDuration <= 0) {
            return null;
        }

        const layout = getVideoLayout(this.videoFormat);
        const extent = `${layout.width}x${layout.height}`;

        const {
            backgroundPath,
            fallbackBackground,
            backgroundOffset = 0,
            loopVideo = true
        } = options;

        const candidates = [];
        if (backgroundPath) candidates.push(backgroundPath);
        if (fallbackBackground) candidates.push(fallbackBackground);

        let resolvedBackground = null;
        for (const candidate of candidates) {
            if (candidate && fs.existsSync(candidate)) {
                resolvedBackground = candidate;
                break;
            }
        }

        const lowerBg = resolvedBackground ? resolvedBackground.toLowerCase() : '';
        const isBgVideo = resolvedBackground
            ? (lowerBg.endsWith('.mp4') || lowerBg.endsWith('.mov') || lowerBg.endsWith('.avi') || lowerBg.endsWith('.mkv'))
            : false;

        const offsetSeconds = (typeof backgroundOffset === 'number' && isFinite(backgroundOffset) && backgroundOffset > 0)
            ? backgroundOffset
            : 0;

        return new Promise((resolve, reject) => {
            const command = ffmpeg();

            if (resolvedBackground) {
                if (isBgVideo) {
                    const inputOpts = ['-t', `${safeDuration + 1}`];
                    if (offsetSeconds > 0) {
                        inputOpts.push('-ss', `${offsetSeconds}`);
                    }
                    if (loopVideo) {
                        inputOpts.push('-stream_loop', '-1');
                    }
                    command.input(resolvedBackground).inputOptions(inputOpts);
                } else {
                    command.input(resolvedBackground).inputOptions(['-loop', '1', '-t', `${safeDuration}`]);
                }
            } else {
                command.input(`color=c=black:s=${extent}:d=${safeDuration}`).inputOptions(['-f', 'lavfi']);
            }

            command.input('anullsrc=channel_layout=stereo:sample_rate=44100')
                .inputOptions(['-f', 'lavfi']);

            command
                .outputOptions([
                    '-t', `${safeDuration}`,
                    '-shortest',
                    '-pix_fmt', 'yuv420p',
                    '-c:v', 'libx264',
                    '-preset', 'ultrafast',
                    '-crf', '18',
                    '-r', '30',
                    '-s', extent,
                    '-vf', 'fps=30,format=yuv420p',
                    '-c:a', 'aac',
                    '-ar', '44100',
                    '-ac', '2'
                ])
                .on('end', () => resolve(outputPath))
                .on('error', (err) => {
                    console.error('無音クリップの生成に失敗しました:', err);
                    reject(err);
                })
                .save(outputPath);
        });
    }

    /**
     * テキストオーバーレイと音声を合わせた動画クリップを作成
     * @param {string} videoPath - 元の動画/画像パス
     * @param {string} text - テキスト
     * @param {string} audioPath - 音声ファイルパス
     * @param {string} imagePath - 画像ファイルパス
     * @param {string} outputPath - 出力パス
     * @param {number} duration - 長さ（秒）
     * @param {number} backgroundOffset - 背景動画の開始位置（秒）
     * @returns {Promise<{ outputPath: string, duration: number }>} 出力情報
     */
    async _createVideoClipWithText(videoPath, text, audioPath, imagePath, outputPath, duration, backgroundOffset = 0, loopVideo = true, loopImage = true, padAudioTailOneSec = false, seFileName = null, effect = null, useZoom = false, initialZoom = 1.0, language = LANGUAGE_CODES.JAPANESE, callout = null) {
        const timer = performanceLogger.startTimer('createVideoClipWithText');
        performanceLogger.addLog('createVideoClipWithText_start', {
            videoPath,
            audioPath,
            duration,
            backgroundOffset,
            loopVideo,
            loopImage
        });

        console.log(`======== クリップ作成開始 =======`);
        console.log(`[DEBUG][詳細] 音声ファイル: ${audioPath}`);
        console.log(`[DEBUG][詳細] 背景ファイル: ${videoPath}`);
        console.log(`[DEBUG][詳細] 指定された長さ: ${duration}秒`);
        console.log(`[DEBUG][詳細] 背景オフセット: ${backgroundOffset}秒`);
        console.log(`[DEBUG][詳細] 背景ループ設定: ${loopVideo ? 'あり' : 'なし'}`);
        console.log(`[DEBUG][詳細] 画像ループ設定: ${loopImage ? 'あり' : 'なし'}`);
        console.log(`[DEBUG][詳細] 出力先: ${outputPath}`);

        // 動画フォーマット（横長/ショート）に応じたレイアウト
        const layout = getVideoLayout(this.videoFormat);
        const extent = `${layout.width}x${layout.height}`;
        const subtitleConfig = layout.subtitles || {};
        const calloutConfig = layout.callout || {};
        const pipConfig = layout.pip || {};
        const pipDiameter = Number(pipConfig.diameter) || 675;
        const pipOverlayX = pipConfig.overlayX || '1500';
        const pipOverlayY = pipConfig.overlayY || '650';
        const normalizedClipLanguage = normalizeLanguage(language);
        const isShortVideo = normalizeVideoFormat(this.videoFormat) === VIDEO_FORMATS.SHORT;

        const playbackSpeed = (typeof this.playbackSpeed === 'number' && this.playbackSpeed > 0)
            ? this.playbackSpeed
            : 1.0;

        const requestedDuration = (typeof duration === 'number' && !isNaN(duration) && duration > 0)
            ? duration
            : null;

        // SVG形式のimagePath検出時は変換処理を実行
        if (imagePath && imagePath.toLowerCase().endsWith('.svg')) {
            try {
                console.log(`[DEBUG][詳細] SVG形式の画像を検出しました: ${imagePath}`);
                // SVGをPNGに変換
                imagePath = await convertSvgToPng(imagePath);
                console.log(`[DEBUG][詳細] SVG画像をPNGに変換しました: ${imagePath}`);
            } catch (error) {
                console.error(`[ERROR][詳細] SVG変換エラー: ${error.message}`);
                // 変換に失敗した場合はimagePath を未定義にして処理を続行
                imagePath = undefined;
            }
        }

        // 音声ファイルの実際の長さを確認と必要に応じて代替値として使用
        let actualAudioDuration = 0;
        let playbackAdjustedDuration = null;
        try {
            actualAudioDuration = await this.getAudioDuration(audioPath);
            playbackAdjustedDuration = (Math.abs(playbackSpeed - 1.0) > 0.001 && actualAudioDuration > 0)
                ? actualAudioDuration / playbackSpeed
                : actualAudioDuration;
            console.log(`[DEBUG][詳細] 音声ファイル実測: ${audioPath}, 実際の長さ: ${actualAudioDuration}秒, 再生速度適用後の推定: ${playbackAdjustedDuration}秒`);
        } catch (err) {
            console.error(`[ERROR][詳細] 音声ファイル長さ取得エラー: ${err.message}`);
            // エラー時も最低1秒の長さを保証
            playbackAdjustedDuration = null;
        }

        if (!Number.isFinite(playbackAdjustedDuration) || playbackAdjustedDuration <= 0) {
            playbackAdjustedDuration = actualAudioDuration;
        }

        let safeDuration = playbackAdjustedDuration;
        if (requestedDuration && requestedDuration > safeDuration) {
            safeDuration = requestedDuration;
        }
        if (!Number.isFinite(safeDuration) || safeDuration <= 0) {
            safeDuration = actualAudioDuration || 1.0;
        }

        const EPSILON = 0.05; // 50msの余裕を持たせてクリップ末尾の切れ込みを防止
        safeDuration = Math.max(0.05, safeDuration + EPSILON);
        duration = safeDuration;

        if (requestedDuration && Math.abs(safeDuration - requestedDuration) > 0.1) {
            console.warn(`[WARNING][詳細] 指定された長さ(${requestedDuration}秒)と補正後の長さ(${safeDuration}秒)に差があります。`);
        }
        if (Number.isFinite(playbackAdjustedDuration) && Math.abs(safeDuration - playbackAdjustedDuration) > 0.1) {
            console.warn(`[WARNING][詳細] 再生速度を考慮した推定長(${playbackAdjustedDuration}秒)と補正後の長さ(${safeDuration}秒)に差があります。`);
        }
        console.log(`[DEBUG] 使用する最終的な長さ: ${safeDuration}秒 (requested=${requestedDuration ?? '未指定'}, actual=${actualAudioDuration}秒)`);

        // 背景動画の長さを取得（背景オフセットの処理に使用）
        let videoDuration = 0;
        const isVideo = videoPath && (
            videoPath.toLowerCase().endsWith('.mp4') ||
            videoPath.toLowerCase().endsWith('.mov') ||
            videoPath.toLowerCase().endsWith('.avi')
        );

        if (isVideo && backgroundOffset > 0) {
            try {
                videoDuration = await getVideoDuration(videoPath);
                console.log(`[DEBUG][詳細] 背景動画実測: ${videoPath}, 実際の長さ: ${videoDuration}秒`);

                // ループ設定時のオフセット処理は警告のみ表示（値は変更しない）
                if (backgroundOffset >= videoDuration) {
                    console.log(`[DEBUG][詳細] 背景オフセット(${backgroundOffset}秒)が動画長さ(${videoDuration}秒)を超えています。ループ再生で連続性を維持します。`);
                }
            } catch (err) {
                console.warn(`[WARNING][詳細] 背景動画の長さ取得に失敗しました: ${err.message}`);
                console.warn(`[WARNING][詳細] オフセットは変更せずに処理を続行します。`);
            }
        }

        return new Promise((resolve, reject) => {
            // 動画ファイルかどうかを判定（拡張子で簡易判定）
            // 入力ファイル判定のデバッグ情報を追加
            console.log(`[DEBUG] 入力ファイルタイプ確認 - videoPath: ${videoPath || 'なし'}`);
            console.log(`[DEBUG] 入力ファイルタイプ判定 - isVideo: ${isVideo}`);
            if (isVideo) {
                console.log(`[DEBUG] 動画入力として処理します: ${videoPath}`);
            } else {
                console.log(`[DEBUG] 画像入力として処理します: ${videoPath || 'デフォルト背景'}`);
            }

            // imagePath のデバッグ情報
            let hasValidImage = false;
            if (imagePath) {
                const isImageVideo = imagePath && (
                    imagePath.toLowerCase().endsWith('.mp4') ||
                    imagePath.toLowerCase().endsWith('.mov') ||
                    imagePath.toLowerCase().endsWith('.avi')
                );
                console.log(`[DEBUG] imagePath: ${imagePath}, 動画ファイル判定: ${isImageVideo}`);

                // 実際にファイルが存在するか確認
                if (fs.existsSync(imagePath)) {
                    hasValidImage = true;
                }
            }

            // プラットフォームに応じたフォントパスの設定
            let fontPath;
            if (process.platform === 'darwin') {
                // macOS
                fontPath = '/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc';
            } else if (process.platform === 'win32') {
                // Windows
                fontPath = 'C:\\Windows\\Fonts\\msgothic.ttc';
            } else {
                // Linux その他
                fontPath = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
            }

            let command = ffmpeg();
            let complexFilters = [];
            let inputIndex = 0;
            let videoInputLabel = '';
            let audioInputLabel = '';
            let imageInputLabel = '';
            let pipVideoInputLabel = '';
            let mapOptions = [];

            // Input 0: Main Video/Background (背景なしの場合は追加しない)
            if (videoPath) {
                if (isVideo) {
                    // ビデオ入力の場合はビデオ属性として使用
                    console.log(`[DEBUG][詳細] 動画を背景として使用: ${videoPath}, オフセット: ${backgroundOffset}秒`);

                    // ループ設定がある場合は、stream_loopオプションを追加
                    let inputOpts = ['-t', `${safeDuration + 1}`]; // 少し余裕を持たせる

                    // 背景オフセットを-ssオプションとして追加（trim filterの代わりに）
                    if (backgroundOffset > 0) {
                        inputOpts.push('-ss', `${backgroundOffset}`);
                        console.log(`[DEBUG][詳細] 背景動画開始位置をシーク設定: -ss ${backgroundOffset}`);
                    }

                    // 背景オフセットが大きい場合は、ループを自動的に有効にする
                    if (loopVideo || (backgroundOffset > 0 && videoDuration > 0 && backgroundOffset + safeDuration > videoDuration)) {
                        inputOpts.push('-stream_loop', '-1'); // -1でエンドレスループ
                        console.log(`[DEBUG][詳細] 動画ループが有効: -stream_loop -1 (${loopVideo ? 'ユーザー指定' : 'オフセット補正のため自動有効化'})`);
                    }

                    command.input(videoPath)
                        .inputOptions(inputOpts);

                    videoInputLabel = `[${inputIndex}:v]`;

                    // trimフィルター部分を削除/コメントアウト（-ssオプションで代替）
                    // 以下のif文を削除または修正する
                    /*
                    if (backgroundOffset > 0) {
                        // 元のビデオ入力ラベルを退避
                        const rawVideoInputLabel = videoInputLabel;
                        
                        if (hasValidImage) {
                            // イメージがある場合は、trimフィルターは背景には適用せず、ラベルだけ変更しない
                            console.log(`[DEBUG][詳細] 画像があるため、背景のtrimは適用しません（PiPに適用予定）`);
                            // videoInputLabelはそのまま [0:v] を使う
                        } else {
                            // イメージがない場合は通常通りtrimフィルターを適用
                            // 背景動画を指定位置からtrimするフィルターを追加
                            const trimFilter = `${rawVideoInputLabel}trim=start=${backgroundOffset}:duration=${safeDuration},setpts=PTS-STARTPTS[trimmed_bg]`;
                            console.log(`[DEBUG][詳細] トリムフィルター: ${trimFilter}`);
                            complexFilters.push(trimFilter);
                            // ビデオ入力ラベルを変更（後続処理用）
                            videoInputLabel = '[trimmed_bg]';
                            console.log(`[DEBUG][詳細] 背景動画開始位置を調整: ${backgroundOffset}秒から、長さ${safeDuration}秒`);
                        }
                    }
                    */
                } else {
                    // 静止画の場合
                    console.log(`[DEBUG][詳細] 画像を背景として使用: ${videoPath}`);
                    console.log(`[DEBUG][詳細] 入力オプション: -loop 1, -t ${safeDuration}`);
                    command.input(videoPath)
                        .inputOptions(['-loop', '1']) // 画像をループさせる
                        .inputOptions(['-t', `${safeDuration}`]); // 必要な長さに制限

                    videoInputLabel = `[${inputIndex}:v]`;
                }
                inputIndex++;
            } else {
                // 背景が指定されていない場合、黒背景のみを使用する
                console.log(`[DEBUG][詳細] 背景指定なし。黒背景のみを使用します。`);
                // ここではビデオ入力ラベルは設定しない（基本キャンバスのみ使用）
            }

            // Input 1: Audio
            command.input(audioPath);
            audioInputLabel = `[${inputIndex}:a]`;
            inputIndex++;

            // Input 2: Optional Image Overlay
            if (imagePath && fs.existsSync(imagePath)) {
                // imagePathが動画の場合はサムネイルとして使う
                const isImageVideo = imagePath && (
                    imagePath.toLowerCase().endsWith('.mp4') ||
                    imagePath.toLowerCase().endsWith('.mov') ||
                    imagePath.toLowerCase().endsWith('.avi')
                );

                if (isImageVideo) {
                    console.log(`[DEBUG] 動画をサムネイルソースとして使用: ${imagePath}`);
                    try {
                        // ループ設定がある場合は、stream_loopオプションを追加
                        let inputOpts = [];
                        if (loopImage) {
                            inputOpts.push('-stream_loop', '-1'); // -1でエンドレスループ
                            console.log(`[DEBUG][詳細] サムネイル動画ループが有効: -stream_loop -1`);
                        }

                        command.input(imagePath)
                            .inputOptions(inputOpts);

                        imageInputLabel = `[${inputIndex}:v]`;
                        inputIndex++;

                        // 背景として使用する動画にもオフセットを適用
                        if (backgroundOffset > 0) {
                            const bgTrimFilter = `${imageInputLabel}trim=start=${backgroundOffset}:duration=${safeDuration},setpts=PTS-STARTPTS[bg_trimmed]`;
                            console.log(`[DEBUG][詳細] 背景サムネイル用トリムフィルター: ${bgTrimFilter}`);
                            complexFilters.push(bgTrimFilter);
                            // 背景用のラベルを変更
                            imageInputLabel = '[bg_trimmed]';
                        }
                    } catch (err) {
                        console.warn(`サムネイル動画の読み込みに失敗しました (${imagePath}), スキップします:`, err);
                        imagePath = null;
                        imageInputLabel = '';
                        hasValidImage = false;
                    }
                } else {
                    console.log(`[DEBUG] 画像をサムネイルとして使用: ${imagePath}`);
                    try {
                        // 静止画の場合、ループ設定を追加
                        let inputOpts = [];
                        if (loopImage) {
                            inputOpts.push('-loop', '1');
                            console.log(`[DEBUG][詳細] サムネイル画像ループが有効: -loop 1`);
                        }

                        command.input(imagePath)
                            .inputOptions(inputOpts);

                        imageInputLabel = `[${inputIndex}:v]`;
                        inputIndex++;
                    } catch (err) {
                        console.warn(`画像ファイルの読み込みに失敗しました (${imagePath}), スキップします:`, err);
                        imagePath = null;
                        imageInputLabel = '';
                        hasValidImage = false;
                    }
                }
            } else if (imagePath) {
                imagePath = null;
                imageInputLabel = '';
                hasValidImage = false;
            }

            // Input 3: 追加でPiP用に同じ背景動画をもう一度入力（オフセットなし）
            if (isVideo && hasValidImage) {
                // オフセットを適用せず、別入力として追加
                console.log(`[DEBUG] PiPには別の入力を使用します: ${videoPath} (オフセットなし)`);

                // ループ設定がある場合は、stream_loopオプションを追加
                let inputOpts = [];
                if (loopImage) {
                    inputOpts.push('-stream_loop', '-1'); // -1でエンドレスループ
                    console.log(`[DEBUG][詳細] PiP動画ループが有効: -stream_loop -1`);
                }

                command.input(videoPath)
                    .inputOptions(inputOpts);

                pipVideoInputLabel = `[${inputIndex}:v]`;
                inputIndex++;

                // PiP用の動画にはオフセットを適用しない（常に0秒から開始）
                console.log(`[DEBUG][詳細] PiP用の動画は0秒から開始します`);
            }

            // Input 4: SE (if present)
            let seInputLabel = '';
            if (seFileName) {
                const sePath = path.join(getAssetsPath(), 'se', seFileName);
                if (fs.existsSync(sePath)) {
                    console.log(`[DEBUG] SEを追加: ${sePath}`);
                    command.input(sePath);
                    seInputLabel = `[${inputIndex}:a]`;
                    inputIndex++;
                } else {
                    console.warn(`SEファイルが見つかりません: ${sePath}`);
                }
            }

            // Apply Video Effects to videoInputLabel (Background/Main) and pipVideoInputLabel (PiP)
            if (effect) {
                const applyEffect = (inputLabel, labelSuffix) => {
                    let newLabel = inputLabel;
                    console.log(`[DEBUG] ビデオエフェクト適用 (${labelSuffix}): ${effect}`);
                    if (effect === 'gray') {
                        const grayLabel = `[v_gray_${labelSuffix}]`;
                        complexFilters.push(`${inputLabel}hue=s=0${grayLabel}`);
                        newLabel = grayLabel;
                    } else if (effect === 'glow') {
                        const glowLabel = `[v_glow_${labelSuffix}]`;
                        const baseLabel = `[base_${labelSuffix}_${Date.now()}]`;
                        const blurLabel = `[blur_${labelSuffix}_${Date.now()}]`;
                        const glowLayerLabel = `[glow_layer_${labelSuffix}_${Date.now()}]`;

                        complexFilters.push(`${inputLabel}split${baseLabel}${blurLabel}`);

                        // 1. 色調整: 確実に白黒にするため hue=s=0 を使用する
                        // 2. アニメーション: 速度を上げる (周期1秒)
                        // 振幅も少し大きくして視認性を高める (0.15)
                        // brightness='-0.05+0.15*sin(2*PI*t/1)'
                        complexFilters.push(`${blurLabel}gblur=sigma=20:steps=3,` +
                            `hue=s=0,` +
                            `eq=contrast=2.0:brightness='-0.1+0.1*sin(2*PI*t/1)':eval=frame` +
                            `${glowLayerLabel}`);

                        // 3. 合成: 輝度(Y)のみScreen合成し、色差(UV)はベースを維持
                        // これにより、グローによる変色（ピンク化など）を完全に防ぐ
                        complexFilters.push(`${baseLabel}${glowLayerLabel}blend=` +
                            `c0_mode=screen:` +
                            `c1_expr='A':` +
                            `c2_expr='A'` +
                            `${glowLabel}`);

                        newLabel = glowLabel;
                    }
                    return newLabel;
                };

                if (videoInputLabel) {
                    videoInputLabel = applyEffect(videoInputLabel, 'main');
                }
                if (pipVideoInputLabel) {
                    pipVideoInputLabel = applyEffect(pipVideoInputLabel, 'pip');
                }

            }

            // Apply Zoom Effect if requested (Slow Zoom)
            let finalZoom = initialZoom;
            if (useZoom) {
                // Calculate final zoom based on duration and speed (0.0005 per frame at 30fps)
                const zoomSpeed = 0.0005;
                const fps = 30;
                const totalFrames = Math.ceil(safeDuration * fps);
                finalZoom = initialZoom + (totalFrames * zoomSpeed);

                const applyZoom = (inputLabel, labelSuffix) => {
                    const upscaledLabel = `[v_up_${labelSuffix}]`;
                    const zoomedLabel = `[v_zoomed_${labelSuffix}]`;
                    const downscaledLabel = `[v_down_${labelSuffix}]`;
                    const zoomLabel = `[v_zoom_${labelSuffix}]`; // Final label to return

                    // 1. Upscale to 2x（横長: 1920x1080 → 3840x2160 / ショート: 1080x1920 → 2160x3840）
                    //    ピクセルスナップの軽減（Jitter reduction）
                    const upscaleWidth = Math.round(layout.width * 2);
                    const upscaleHeight = Math.round(layout.height * 2);
                    complexFilters.push(`${inputLabel}scale=${upscaleWidth}:${upscaleHeight}${upscaledLabel}`);

                    // 2. Zoompan
                    // z: start at initialZoom, increment 0.0005 per frame
                    // d: duration in frames (add buffer)
                    // s: output size (keep 4K)
                    // fps: force 30fps
                    const zoomExpr = `min(if(eq(on,0),${initialZoom},zoom+${zoomSpeed}),2.0)`;
                    complexFilters.push(`${upscaledLabel}zoompan=z='${zoomExpr}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${totalFrames + 100}:s=${upscaleWidth}x${upscaleHeight}:fps=${fps}${zoomedLabel}`);

                    // 3. Downscale back to output size
                    complexFilters.push(`${zoomedLabel}scale=${layout.width}:${layout.height}${downscaledLabel}`);

                    return downscaledLabel;
                };

                if (videoInputLabel) {
                    videoInputLabel = applyZoom(videoInputLabel, 'main');
                }
                if (pipVideoInputLabel) {
                    pipVideoInputLabel = applyZoom(pipVideoInputLabel, 'pip');
                }
            }

            let baseCanvasLabel = '[base]';
            let scaledMainLabel = '[scaled_main]';
            let mainOnBaseLabel = '[main_on_base]';
            let circularVideoLabel = '[circular_video]';
            let videoBeforeTextLabel = '';

            // 1. Create base black canvas (安全な長さを使用)
            complexFilters.push(`color=c=black:s=${extent}:d=${safeDuration}${baseCanvasLabel}`);

            // 2. 画像がある場合は画像を全面に配置、ない場合はビデオを全面に配置（ビデオがある場合）
            if (hasValidImage) {
                // 2a. Scale image to full screen with aspect ratio preservation and fill the screen
                complexFilters.push(
                    `${imageInputLabel}scale=${layout.width}:${layout.height}:force_original_aspect_ratio=increase,crop=${layout.width}:${layout.height},setsar=1${scaledMainLabel}`
                );
                // 2b. Place image on base canvas centered
                complexFilters.push(
                    `${baseCanvasLabel}${scaledMainLabel}overlay=x=(main_w-W)/2:y=(main_h-H)/2${mainOnBaseLabel}`
                );

                // 3. Scale video to small size for PiP and make it circular
                // PiP用には別の入力を使用する（オフセットを適用しない）
                const pipInputLabel = pipVideoInputLabel || videoInputLabel;
                if (pipInputLabel) {
                    console.log(`[DEBUG] PiP用の入力ラベル: ${pipInputLabel} (${pipVideoInputLabel ? '新規入力使用' : 'メイン入力と同じ'})`);
                    console.log(`[DEBUG][詳細] PiP動画処理: ループ設定=${loopImage ? 'あり' : 'なし'}, 入力ラベル=${pipInputLabel}`);

                    complexFilters.push(
                        `${pipInputLabel}scale=${pipDiameter}:${pipDiameter}:force_original_aspect_ratio=decrease,` +
                        `crop=min(iw\\,ih):min(iw\\,ih):(iw-min(iw\\,ih))/2:(ih-min(iw\\,ih))/2,` +
                        `format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':` +
                        `a='if(gt(sqrt(pow(X-(W/2),2)+pow(Y-(H/2),2)),min(W,H)/2),0,alpha(X,Y))'${circularVideoLabel}`
                    );

                    // 4. Overlay circular video on image in bottom right
                    complexFilters.push(
                        `${mainOnBaseLabel}${circularVideoLabel}overlay=x=${pipOverlayX}:y=${pipOverlayY}[final_layout]`
                    );
                    videoBeforeTextLabel = '[final_layout]';
                } else {
                    console.warn('[DEBUG] PiP用の動画が無いためスキップします');
                    videoBeforeTextLabel = mainOnBaseLabel;
                }
            } else if (videoPath) {
                // If no image, use main video as background (if exists)
                // - 横長: 画面内に収める（見切れなし）
                // - ショート: 縦に合わせて左右をセンターで見切る（横が見切れるように crop）
                const mainVideoScaleFilter = isShortVideo
                    ? `scale=${layout.width}:${layout.height}:force_original_aspect_ratio=increase,crop=${layout.width}:${layout.height},setsar=1`
                    : `scale=${layout.width}:${layout.height}:force_original_aspect_ratio=decrease,setsar=1`;
                complexFilters.push(
                    `${videoInputLabel}${mainVideoScaleFilter}${scaledMainLabel}`
                );
                complexFilters.push(
                    `${baseCanvasLabel}${scaledMainLabel}overlay=x=(main_w-W)/2:y=(main_h-H)/2${mainOnBaseLabel}`
                );
                videoBeforeTextLabel = mainOnBaseLabel;
            } else {
                // 背景もサムネイルもない場合、黒背景をそのまま使用
                console.log(`[DEBUG][詳細] 背景もサムネイルもないため、黒背景をそのまま使用します`);
                videoBeforeTextLabel = baseCanvasLabel;
            }

            // 字幕・CallOut のレイアウト設定（横長/ショートで切替）
            const subtitleMaxWidthRatio = Number(subtitleConfig.maxWidthRatio) || SUBTITLE_MAX_WIDTH_RATIO;
            const fontSize = Number(subtitleConfig.fontSize) || 48;
            const boxH = Number(subtitleConfig.boxHeight) || 135;
            const subtitleBottomMargin = Number(subtitleConfig.bottomMargin) || 80;

            const calloutMaxWidthRatio = Number(calloutConfig.maxWidthRatio) || 0.9;
            const calloutFontSize = Number(calloutConfig.fontSize) || 84;
            const calloutMarginXBase = Number(calloutConfig.marginX) || 60;
            const calloutMarginYBase = Number(calloutConfig.marginY) || 70;
            const calloutPaddingExtra = CALLOUT_PADDING_EXTRA_PX_BY_LANGUAGE[normalizedClipLanguage] || {};
            const calloutMarginX = Math.max(0, calloutMarginXBase + (Number(calloutPaddingExtra.marginX) || 0));
            const calloutMarginY = Math.max(0, calloutMarginYBase + (Number(calloutPaddingExtra.marginY) || 0));
            let textFilePath = null;
            let calloutAssPath = null;

            const calloutPayload = (callout && typeof callout === 'object') ? callout : null;
            const calloutText = (typeof callout === 'string')
                ? callout.trim()
                : (typeof calloutPayload?.text === 'string' ? calloutPayload.text.trim() : '');
            const calloutMode = (calloutPayload && calloutPayload.mode === 'static') ? 'static' : 'typewriter';
            const shouldDrawCallout = !!calloutText;
            if (shouldDrawCallout) {
                const escapeAssText = (value) => (
                    String(value ?? '')
                        .replace(/\\/g, '\\\\')
                        .replace(/{/g, '\\{')
                        .replace(/}/g, '\\}')
                        .replace(/\r?\n/g, '\\N')
                );
                const formatAssTime = (seconds) => {
                    const cs = Math.max(0, Math.round(Number(seconds) * 100));
                    const h = Math.floor(cs / 360000);
                    const m = Math.floor((cs % 360000) / 6000);
                    const s = Math.floor((cs % 6000) / 100);
                    const c = cs % 100;
                    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
                };

                // CallOut も横幅に合わせて折り返す（ショート時に横はみ出ししやすいため）
                const rawCalloutText = String(calloutText ?? '')
                    // 単語途中の改行を復元（英語など）
                    .replace(/([\p{L}\p{N}])\r?\n([\p{L}\p{N}])/gu, '$1$2')
                    .replace(/\r?\n+/g, '\n')
                    .replace(/[ \t]+/g, ' ')
                    .trim();
                const calloutWrapMultiplier = SUBTITLE_WRAP_CHARS_MULTIPLIER_BY_LANGUAGE[normalizedClipLanguage] ?? 1.0;
                // 余白(padding)を加味して折り返し幅を決める（ASSのMarginと整合させる）
                const calloutTargetWidthPx = Math.max(
                    1,
                    Math.floor(layout.width * calloutMaxWidthRatio) - (calloutMarginX * 2)
                );
                const calloutBaseEstimatedChars = Math.floor(calloutTargetWidthPx / Math.max(calloutFontSize, 1));
                const calloutEstimatedChars = Math.floor(calloutBaseEstimatedChars * calloutWrapMultiplier);
                const calloutMaxCharsPerLine = Math.max(
                    CALLOUT_WRAP_MIN_CHARS_PER_LINE,
                    Math.min(SUBTITLE_WRAP_MAX_CHARS_PER_LINE, calloutEstimatedChars)
                );
                const wrappedCalloutText = wrapTextForDrawText(rawCalloutText, calloutMaxCharsPerLine, normalizedClipLanguage);

                const totalSeconds = Math.max(0.05, Number(duration) || 0.05);
                const totalCs = Math.max(1, Math.round(totalSeconds * 100));

                const dialogues = [];
                if (calloutMode === 'static') {
                    // 2つ目以降のセグメントではアニメーションを走らせず、完成形を最初から表示して維持する
                    dialogues.push(
                        `Dialogue: 0,${formatAssTime(0)},${formatAssTime(totalSeconds)},Callout,,0,0,0,,${escapeAssText(wrappedCalloutText)}`
                    );
                } else {
                    const chars = Array.from(wrappedCalloutText);
                    const charCount = chars.length;

                    const perCharSeconds = 0.06;
                    const minRevealSeconds = 0.4;
                    const maxRevealSeconds = Math.min(4.0, totalSeconds * 0.9);
                    let revealSeconds = Math.min(Math.max(charCount * perCharSeconds, minRevealSeconds), maxRevealSeconds);
                    if (!Number.isFinite(revealSeconds) || revealSeconds <= 0) {
                        revealSeconds = Math.min(1.2, totalSeconds);
                    }
                    if (revealSeconds > totalSeconds) {
                        revealSeconds = totalSeconds;
                    }
                    const revealCs = Math.max(1, Math.round(revealSeconds * 100));

                    if (charCount > 0) {
                        for (let i = 1; i <= charCount; i += 1) {
                            const startCs = Math.round(((i - 1) * revealCs) / charCount);
                            let endCs = Math.round((i * revealCs) / charCount);
                            if (endCs <= startCs) {
                                endCs = startCs + 1;
                            }
                            if (startCs >= totalCs) break;
                            const clippedEndCs = Math.min(endCs, totalCs);
                            const prefix = chars.slice(0, i).join('');
                            dialogues.push(
                                `Dialogue: 0,${formatAssTime(startCs / 100)},${formatAssTime(clippedEndCs / 100)},Callout,,0,0,0,,${escapeAssText(prefix)}`
                            );
                        }

                        if (revealCs < totalCs) {
                            dialogues.push(
                                `Dialogue: 0,${formatAssTime(revealCs / 100)},${formatAssTime(totalCs / 100)},Callout,,0,0,0,,${escapeAssText(wrappedCalloutText)}`
                            );
                        }
                    }
                }

                if (dialogues.length > 0) {
                    const assContent = [
                        '[Script Info]',
                        'ScriptType: v4.00+',
                        `PlayResX: ${layout.width}`,
                        `PlayResY: ${layout.height}`,
                        'ScaledBorderAndShadow: yes',
                        '',
                        '[V4+ Styles]',
                        'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
                        // Top-center (Alignment=8), with border + drop shadow
                        `Style: Callout,Reggae One,${calloutFontSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,5,3,8,${calloutMarginX},${calloutMarginX},${calloutMarginY},1`,
                        '',
                        '[Events]',
                        'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
                        ...dialogues,
                        ''
                    ].join('\n');

                    calloutAssPath = path.join(
                        TEMP_DIR,
                        `callout_${Date.now()}_${Math.random().toString(16).slice(2)}.ass`
                    );
                    fs.writeFileSync(calloutAssPath, assContent, 'utf8');
                }
            }

            // 既に入っている改行（過去の折り返し）を除去し、80%幅で再ラップする
            // - 英語で「that → tha t」「money → mon ey」のようになるのは、単語途中に改行が入っているのに
            //   それをスペースに置換してしまうため。文字と文字の間の改行は「削除」して単語を復元する。
            const rawSubtitleText = String(text ?? '')
                // 単語途中の改行を復元（that -> tha\n t / tha\nt のようなケース）
                .replace(/([\p{L}\p{N}])\r?\n([\p{L}\p{N}])/gu, '$1$2')
                .replace(/\r?\n+/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();

            const shouldDrawSubtitles = this.captionsEnabled !== false && !!rawSubtitleText;
            const afterCaptionsLabel = '[v_captioned]';
            if (shouldDrawSubtitles) {
                // 6. テキストをファイルとして保存（字幕幅=画面の80%相当で折り返す）
                textFilePath = path.join(TEMP_DIR, `text_${Date.now()}.txt`);

                // 言語に応じて折り返し文字数の補正を適用（英語は1行が短く見えやすい）
                const normalizedSubtitleLanguage = normalizedClipLanguage;
                const wrapMultiplier = SUBTITLE_WRAP_CHARS_MULTIPLIER_BY_LANGUAGE[normalizedSubtitleLanguage] ?? 1.0;

                const targetWidthPx = layout.width * subtitleMaxWidthRatio;
                const baseEstimatedChars = Math.floor(targetWidthPx / Math.max(fontSize, 1));
                const estimatedChars = Math.floor(baseEstimatedChars * wrapMultiplier);
                const maxCharsPerLine = Math.max(
                    SUBTITLE_WRAP_MIN_CHARS_PER_LINE,
                    Math.min(SUBTITLE_WRAP_MAX_CHARS_PER_LINE, estimatedChars)
                );
                const wrappedSubtitleText = wrapTextForDrawText(rawSubtitleText, maxCharsPerLine, normalizedSubtitleLanguage);
                fs.writeFileSync(textFilePath, wrappedSubtitleText);

                // 6. Drawtext filterをtextfileオプションを使って置き換え
                complexFilters.push(
                    `${videoBeforeTextLabel}` +
                    `drawbox=` +
                    `x=(iw-${subtitleMaxWidthRatio}*iw)/2:` +        // = 0.1*iw でもOK
                    `y=ih-${boxH}-${subtitleBottomMargin}:` +
                    `w=${subtitleMaxWidthRatio}*iw:` +
                    `h=${boxH}:` +
                    `color=black@0.5:` +
                    `t=fill,` +
                    `drawtext=` +
                    `textfile='${textFilePath}':` +
                    `fontfile='${fontPath}':` +
                    `fontsize=${fontSize}:expansion=none:` +
                    `fontcolor=white:` +
                    `x=(w-text_w)/2:` +         // drawtext の w/h は動画サイズでOK :contentReference[oaicite:1]{index=1}
                    `y=h-${boxH}-${subtitleBottomMargin}+(${boxH}-th)/2:` +
                    `borderw=2:bordercolor=black` +
                    `${afterCaptionsLabel}`
                );
            } else {
                // 字幕非表示の場合はそのまま次へ渡す
                complexFilters.push(`${videoBeforeTextLabel}null${afterCaptionsLabel}`);
            }

            // callout（ASS typewriter）を焼き込む（上部中央）
            if (calloutAssPath) {
                const escapeFilterValue = (value) => (
                    String(value ?? '')
                        .replace(/\\/g, '/')
                        .replace(/:/g, '\\:')
                        .replace(/'/g, "\\'")
                );
                const calloutFontsDir = path.join(getAssetsPath(), 'fonts');
                complexFilters.push(
                    `${afterCaptionsLabel}` +
                    `subtitles='${escapeFilterValue(calloutAssPath)}':fontsdir='${escapeFilterValue(calloutFontsDir)}'` +
                    `[v_untrimmed]`
                );
            } else {
                complexFilters.push(`${afterCaptionsLabel}null[v_untrimmed]`);
            }

            // 6.5 Trim the video stream to the exact calculated duration
            complexFilters.push(
                `[v_untrimmed]trim=duration=${duration}[v]`
            );

            // 7. Audio Filter - 再生速度と音量を調整
            const audioFilterParts = [];
            const needsSpeedAdjustment = Math.abs(playbackSpeed - 1.0) > 0.001;
            if (needsSpeedAdjustment) {
                const atempoFilters = this._buildAtempoChain(playbackSpeed);
                audioFilterParts.push(...atempoFilters);
                console.log(`[DEBUG] 音声速度フィルター適用: ${atempoFilters.join(' -> ')}`);
                this.clipsAdjustedForSpeed = this.clipsAdjustedForSpeed || atempoFilters.length > 0;
            }
            audioFilterParts.push('volume=2.5', 'alimiter=limit=1');

            // 最終クリップのみ、音声末尾にサイレンスをパディングして映像長と揃える
            if (padAudioTailOneSec) {
                // apad でサイレンスを追加し、atrim で最終長をクリップ長に揃える
                // （速度調整後のチェーンに続けて適用）
                audioFilterParts.push('apad', `atrim=duration=${duration}`);
            }

            let audioFilter = `${audioInputLabel}${audioFilterParts.join(',')}[a_tts]`;
            complexFilters.push(audioFilter);

            // Mix SE if present
            if (seInputLabel) {
                // Mix TTS audio [a_tts] and SE [seInputLabel]
                // We want SE to play at the beginning.
                // amix=inputs=2:duration=first (duration of the first input, which should be the main TTS audio length or the clip length)
                // Actually, we want the output duration to be the clip duration.
                // Let's use amix.
                // Note: amix might reduce volume. We might need to normalize.
                complexFilters.push(`[a_tts]${seInputLabel}amix=inputs=2:duration=first:dropout_transition=0[a]`);
            } else {
                // Just rename [a_tts] to [a]
                complexFilters.push(`[a_tts]anull[a]`);
            }

            console.log(`[DEBUG] 音声フィルター: ${audioFilterParts.join(' | ')} (playbackSpeed=${playbackSpeed}x)`);
            console.log(`[DEBUG] audioInputLabel: ${audioInputLabel}`);
            console.log(`[DEBUG] audioPath: ${audioPath}`);

            // 入力ラベルが空でないか確認
            if (!audioInputLabel) {
                console.error('[ERROR] audioInputLabelが空です。FFmpegフィルタグラフが破損する可能性があります。');
                audioFilter = `[1:a]volume=2.5,alimiter=limit=1[a]`; // 強制的に修正を試みる
                console.log(`[DEBUG] 修正された音声フィルター: ${audioFilter}`);
            }

            // 音声入力が存在するか確認
            try {
                if (!fs.existsSync(audioPath)) {
                    console.error(`[ERROR] 音声ファイルが存在しません: ${audioPath}`);
                }
            } catch (err) {
                console.error(`[ERROR] 音声ファイルチェックエラー: ${err.message}`);
            }

            // complexFilters.push(audioFilter); // Already pushed above

            command.complexFilter(complexFilters);

            // Output mapping
            mapOptions.push('-map', '[v]');
            mapOptions.push('-map', '[a]');

            // 完全なffmpegコマンドをログ出力
            command.on('start', (cmd) => {
                console.log('[DEBUG] FFmpeg完全コマンド:');
                console.log(cmd);

                // フィルタグラフの詳細解析
                console.log('[DEBUG] フィルタグラフ解析:');
                console.log('- 複合フィルタ数:', complexFilters.length);
                complexFilters.forEach((filter, index) => {
                    console.log(`  ${index + 1}. ${filter}`);

                    // 入力と出力ラベルを識別
                    const inputLabels = (filter.match(/\[\d+:[av]\]/g) || []).join(', ');
                    const outputLabels = (filter.match(/\[[a-z_]+\]/g) || []).join(', ');
                    console.log(`     入力ラベル: ${inputLabels || 'なし'}`);
                    console.log(`     出力ラベル: ${outputLabels || 'なし'}`);
                });

                // 最終的なマッピング確認
                console.log('[DEBUG] 出力マッピング:', mapOptions.join(' '));

                console.log('動画クリップ作成開始');
            });

            console.log('Using fluent-ffmpeg methods pattern (PCM audio)');
            command
                .outputOptions(mapOptions) // ストリームマッピングはそのまま outputOptions で渡すのが確実な場合も
                .videoCodec('libx264')     // ffv1から変更、libx264を使用
                .outputOptions([           // libx264の詳細オプション
                    '-preset', 'ultrafast', // 中間ファイルは処理速度優先
                    '-crf', '23',           // 適度な品質と圧縮率のバランス
                    '-pix_fmt', 'yuv420p',  // より軽量なピクセルフォーマット
                    '-r', '30',             // フレームレート
                    '-s', extent,           // 出力解像度を固定（横長/ショートで切替）
                    '-threads', '0',         // 利用可能なすべてのCPUコアを使用
                    '-c:a', 'aac',          // 中間クリップの音声をAACで統一
                    '-ar', '44100',         // サンプリングレートを44.1kHzに統一
                    '-ac', '2'              // ステレオに統一
                ])
                .output(outputPath)
                .on('end', () => {
                    console.log(`クリップ作成完了: ${outputPath}`);

                    // テンポラリテキストファイルを削除
                    if (textFilePath) {
                        try {
                            if (fs.existsSync(textFilePath)) {
                                fs.unlinkSync(textFilePath);
                            }
                        } catch (err) {
                            console.warn(`一時テキストファイルの削除に失敗: ${textFilePath}`, err);
                        }
                    }
                    if (calloutAssPath) {
                        try {
                            if (fs.existsSync(calloutAssPath)) {
                                fs.unlinkSync(calloutAssPath);
                            }
                        } catch (err) {
                            console.warn(`一時ASSファイルの削除に失敗: ${calloutAssPath}`, err);
                        }
                    }

                    timer.end({
                        outputPath,
                        fileSize: fs.existsSync(outputPath) ? fs.statSync(outputPath).size : 0,
                        duration: safeDuration
                    });

                    resolve({ outputPath, duration: safeDuration, finalZoom });
                })
                .on('error', (err) => {
                    console.error('クリップ作成エラー:', err.message);

                    // エラー解析のための詳細情報
                    console.error('[ERROR DETAILS] フィルタグラフ構造:');
                    complexFilters.forEach((filter, index) => {
                        console.error(`  ${index + 1}. ${filter}`);
                    });
                    console.error('[ERROR DETAILS] 音声入力:', audioPath);
                    console.error('[ERROR DETAILS] 音声ラベル:', audioInputLabel);
                    console.error('[ERROR DETAILS] マッピング:', mapOptions.join(' '));

                    // エラー時にもテンポラリファイルを削除
                    if (textFilePath) {
                        try {
                            if (fs.existsSync(textFilePath)) {
                                fs.unlinkSync(textFilePath);
                            }
                        } catch (cleanupErr) {
                            console.warn(`エラー後の一時ファイル削除に失敗: ${textFilePath}`, cleanupErr);
                        }
                    }
                    if (calloutAssPath) {
                        try {
                            if (fs.existsSync(calloutAssPath)) {
                                fs.unlinkSync(calloutAssPath);
                            }
                        } catch (cleanupErr) {
                            console.warn(`エラー後の一時ファイル削除に失敗: ${calloutAssPath}`, cleanupErr);
                        }
                    }

                    reject(err);
                })
                .run();
        });
    }

    /**
     * FFmpegのatempoフィルターは0.5〜2.0の範囲でしか指定できないため、
     * 指定された速度をこの範囲の積で表現するフィルターチェーンを生成する。
     * @param {number} targetSpeed - 適用したい再生速度
     * @returns {string[]} atempoフィルターの配列
     */
    _buildAtempoChain(targetSpeed) {
        const filters = [];
        if (typeof targetSpeed !== 'number' || !isFinite(targetSpeed) || targetSpeed <= 0) {
            return filters;
        }

        if (Math.abs(targetSpeed - 1.0) < 0.001) {
            return filters;
        }

        let remaining = targetSpeed;

        while (remaining > 2.0) {
            filters.push('atempo=2.0');
            remaining /= 2.0;
        }

        while (remaining < 0.5) {
            filters.push('atempo=0.5');
            remaining /= 0.5; // same as remaining *= 2.0
        }

        // 残りの速度が1.0に極めて近い場合はフィルターを追加しない
        if (Math.abs(remaining - 1.0) > 0.001) {
            const rounded = Math.max(0.5, Math.min(2.0, Number(remaining.toFixed(3))));
            filters.push(`atempo=${rounded}`);
        }

        return filters;
    }

    /**
     * 複数の動画クリップを連結
     * @param {Array<string>} clipPaths - クリップのパス配列
     * @param {string} outputPath - 出力パス
     * @param {Function} onProgress - 進捗コールバック
     * @returns {Promise<string>} 出力パス
     */
    async _concatenateClips(clipPaths, outputPath, onProgress) {
        const timer = performanceLogger.startTimer('concatenateClips');
        performanceLogger.addLog('concatenateClips_start', {
            clipCount: clipPaths.length,
            outputPath
        });

        // --- 大量クリップ用の分割連結ロジック ---
        // FFmpeg の concat フィルタは入力数が多いと失敗することがあるため、
        // MAX_CLIPS_PER_CONCAT ごとに分割して段階的に連結していく。

        if (clipPaths.length > MAX_CLIPS_PER_CONCAT) {
            const dir = path.dirname(outputPath);
            const ext = path.extname(outputPath);
            const base = path.basename(outputPath, ext);

            // 例: concatenated_1700000000.mkv → concatenated_1700000000_1.mkv ...
            const intermediateOutputs = [];

            // 進捗管理用の係数
            const totalChunks = Math.ceil(clipPaths.length / MAX_CLIPS_PER_CONCAT);

            for (let i = 0; i < clipPaths.length; i += MAX_CLIPS_PER_CONCAT) {
                const chunkIndex = Math.floor(i / MAX_CLIPS_PER_CONCAT);
                const chunk = clipPaths.slice(i, i + MAX_CLIPS_PER_CONCAT);

                const chunkOutput = path.join(dir, `${base}_${chunkIndex + 1}${ext}`);

                // 各チャンクを連結（再帰的にこのメソッドを呼び出す）
                await this._concatenateClips(chunk, chunkOutput, (p) => {
                    // チャンク全体の進捗を 0〜0.8 の範囲で概算共有
                    if (onProgress) {
                        const chunkProgress = (chunkIndex + p) / totalChunks;
                        onProgress(chunkProgress * 0.8); // 最初の 80% をチャンク処理に割り当て
                    }
                });

                intermediateOutputs.push(chunkOutput);
            }

            // すべてのチャンクが出来上がったら、それらを最終連結
            const finalOutputPath = path.join(dir, `${base}_all${ext}`);

            await this._concatenateClips(intermediateOutputs, finalOutputPath, (p) => {
                // 残り 20% を最終連結に割り当てる
                if (onProgress) onProgress(0.8 + p * 0.2);
            });

            // 中間ファイルをクリーンアップ
            for (const file of intermediateOutputs) {
                try { fs.unlinkSync(file); } catch (_) { /* ignore */ }
            }

            return finalOutputPath;
        }

        if (clipPaths.length === 0) {
            performanceLogger.addLog('concatenateClips_error', { error: 'No clips to concatenate' });
            throw new Error('連結する動画クリップがありません');
        }

        if (clipPaths.length === 1) {
            // クリップが1つの場合はそのまま返す
            fs.copyFileSync(clipPaths[0], outputPath);
            if (onProgress) onProgress(1);

            performanceLogger.addLog('concatenateClips_single', {
                source: clipPaths[0],
                destination: outputPath,
                fileSize: fs.statSync(outputPath).size
            });

            timer.end({ skipped: true, reason: 'single clip' });
            return outputPath;
        }

        return new Promise((resolve, reject) => {
            const command = ffmpeg();

            // 各クリップを入力として追加
            clipPaths.forEach(clipPath => {
                command.input(clipPath);
            });

            // concatフィルターを構築
            const filterInputs = clipPaths.map((_, index) => `[${index}:v][${index}:a]`).join('');

            // 長さを維持したまま連結するためのconcatフィルター設定
            // v=1:a=1 - ビデオとオーディオのストリームを1つずつ出力
            // n=クリップ数 - 連結するクリップの数
            const filterComplex = `${filterInputs}concat=n=${clipPaths.length}:v=1:a=1[vout][aout]`;

            // オーディオの同期問題を修正するaresampleフィルター
            // min_hard_compを小さくして、拡張を最小限に抑える
            // exact_len=1は削除（サポートされていない）
            const audioFilter = `[aout]aresample=async=1:min_hard_comp=0.01:first_pts=0[afixed]`;
            const finalFilterComplex = `${filterComplex};${audioFilter}`;

            console.log('[DEBUG] concat フィルター設定:', finalFilterComplex);

            command.complexFilter(finalFilterComplex)
                .outputOptions([
                    '-map', '[vout]',
                    '-map', '[afixed]',  // 修正したオーディオを使用
                    // 一つのビデオコーデックオプションのみを使用（矛盾を解消）
                    '-c:v', 'libx264',   // ffv1から変更、より高速な処理のためにH.264を使用
                    '-preset', 'ultrafast', // 中間ファイルなので最高速度優先
                    '-crf', '23',        // 適度な画質と圧縮率の妥協点
                    '-pix_fmt', 'yuv420p', // ffv1の'yuv422p10'からより軽量なフォーマットに変更
                    '-r', '30',          // フレームレート
                    '-threads', '0',     // 利用可能なすべてのCPUコアを使用
                    // オーディオは圧縮形式に変更
                    '-c:a', 'aac',       // 非圧縮PCMから変更
                    '-b:a', '256k'       // 十分な音質のビットレート
                ])
                .output(outputPath)
                .on('start', (cmd) => {
                    console.log('動画連結開始 (concat filter)');
                    console.log('[DEBUG] Concat Filter Command:', cmd); // コマンドログ追加
                    if (onProgress) onProgress(0.5); // 50%から始める
                })
                .on('progress', (progress) => {
                    console.log(`連結進捗: ${progress.percent}%`);
                    if (onProgress) {
                        // 50%〜90%の範囲で進捗を報告
                        const overallProgress = 0.5 + (progress.percent / 100) * 0.4;
                        onProgress(Math.min(0.9, overallProgress));
                    }
                })
                .on('end', () => {
                    console.log('動画連結完了');
                    if (onProgress) onProgress(0.9); // 90%

                    const fileSize = fs.existsSync(outputPath) ? fs.statSync(outputPath).size : 0;
                    timer.end({
                        fileSize,
                        outputExists: fs.existsSync(outputPath)
                    });

                    resolve(outputPath);
                })
                .on('error', (err) => {
                    console.error('動画連結エラー:', err);

                    performanceLogger.addLog('concatenateClips_error', {
                        error: err.message,
                        clipCount: clipPaths.length
                    });

                    reject(err);
                })
                .run();
        });
    }

    /**
     * 動画にBGMを追加
     * @param {string} videoPath - 元の動画パス
     * @param {string} outputPath - 出力パス
     * @param {number} duration - 動画の長さ
     * @param {Function} onProgress - 進捗コールバック
     * @returns {Promise<string>} - 出力ファイルのパス
     */
    async _addBgmToVideo(videoPath, outputPath, duration, onProgress) {
        const timer = performanceLogger.startTimer('addBgmToVideo');
        performanceLogger.addLog('addBgmToVideo_start', {
            videoPath,
            outputPath,
            duration
        });

        console.log(`[DEBUG] BGM追加開始 - 入力動画: ${videoPath}, 出力: ${outputPath}, 予想長さ: ${duration}秒`);

        // 動画ファイルの実際の長さを確認
        let actualDuration = duration;
        try {
            // ffprobeを使用して動画の実際の長さを取得
            await new Promise((resolveProbe, rejectProbe) => {
                ffmpeg.ffprobe(videoPath, (err, metadata) => {
                    if (err) {
                        console.error(`[ERROR] 動画長さ取得エラー: ${err.message}`);
                        rejectProbe(err);
                        return;
                    }

                    if (metadata && metadata.format && metadata.format.duration) {
                        actualDuration = parseFloat(metadata.format.duration);
                        console.log(`[DEBUG] 連結動画の実際の長さ: ${actualDuration}秒 (予想: ${duration}秒)`);
                    } else {
                        console.warn('[WARNING] 動画長さ情報を取得できませんでした、予想値を使用します');
                    }
                    resolveProbe();
                });
            });
        } catch (err) {
            console.error(`[ERROR] ffprobe実行エラー: ${err.message}`);
            console.log('[INFO] 予想値の動画長を使用します');
        }

        return new Promise((resolve, reject) => {
            const command = ffmpeg();

            // 動画入力
            command.input(videoPath);

            // BGM入力 - 実際に測定した動画の長さを使用
            const resolvedBgm = this.currentBgmPath;
            if (!resolvedBgm || !fs.existsSync(resolvedBgm)) {
                reject(new Error(`BGM is not set or missing: ${resolvedBgm || '(none)'}`));
                return;
            }
            command.input(resolvedBgm)
                .inputOptions([
                    '-stream_loop', '-1',  // 無限ループ
                    '-t', `${actualDuration}`    // 測定した動画の長さに合わせる
                ]);

            // 音声フィルター設定
            const bgmVolume = (typeof this.currentBgmVolume === 'number' && Number.isFinite(this.currentBgmVolume))
                ? Math.min(Math.max(this.currentBgmVolume, 0), 1)
                : 0.2;

            // 速度調整を適用するかどうか
            const playbackSpeed = (typeof this.playbackSpeed === 'number' && this.playbackSpeed > 0)
                ? this.playbackSpeed
                : 1.0;
            const audioFilters = [];
            const shouldAdjustHere = !this.clipsAdjustedForSpeed && Math.abs(playbackSpeed - 1.0) > 0.001;

            if (shouldAdjustHere) {
                const atempoFilters = this._buildAtempoChain(playbackSpeed);
                audioFilters.push(...atempoFilters);
                console.log(`[DEBUG] 速度調整 - BGM合成時に音声を ${playbackSpeed}x へ調整 (${atempoFilters.join(' -> ')})`);
                this.clipsAdjustedForSpeed = this.clipsAdjustedForSpeed || atempoFilters.length > 0;
            } else {
                if (Math.abs(playbackSpeed - 1.0) > 0.001) {
                    console.log('[DEBUG] 速度調整はクリップ作成時に適用済みのため、BGM追加では再適用しません');
                } else {
                    console.log('[DEBUG] 速度調整なし（標準速度）');
                }
            }
            audioFilters.push('volume=1.0');

            // 複合フィルター構築
            const complexFilters = [];

            // 音声フィルター
            complexFilters.push(`[0:a]${audioFilters.join(',')}[a1]`);
            complexFilters.push(`[1:a]volume=${bgmVolume}[a2]`);
            // BGM を映像の最後まで鳴らしたいので、amix は duration=longest を使用
            // dropout_transition=0 でフェード等を無効化（切替時の不意な減衰を防止）
            complexFilters.push(`[a1][a2]amix=inputs=2:duration=longest:dropout_transition=0[aout]`);
            console.log(`[DEBUG] BGM処理 - amix=duration=longest:dropout_transition=0`);

            // デバッグのためにフィルター設定をログ出力
            console.log(`[DEBUG] BGM処理 - フィルター: ${JSON.stringify(complexFilters)}`);
            console.log(`[DEBUG] BGM処理 - 速度調整: ${shouldAdjustHere ? 'あり' : 'なし'}, 再生速度: ${playbackSpeed}x`);

            command.complexFilter(complexFilters);

            // ビデオマッピング
            const videoMapOption = '0:v';

            command.outputOptions([
                '-map', videoMapOption,  // 背景映像は常に元の速度で利用
                '-map', '[aout]',        // ミックスした音声を使用
                '-c:v', 'libx264',       // 可逆圧縮ビデオコーデックからH.264に変更
                '-preset', 'ultrafast',  // 中間ファイルなので処理速度優先
                '-crf', '23',            // 中間ファイルなので適度な品質
                '-pix_fmt', 'yuv420p',   // より軽量なピクセルフォーマット
                '-r', '30',              // フレームレート
                '-c:a', 'aac',           // AACオーディオコーデック
                '-b:a', '256k',          // オーディオビットレート
                '-threads', '0',         // 利用可能なすべてのCPUコアを使用
                '-shortest'              // 最短のストリームに合わせて長さを調整
            ])
                .output(outputPath)
                .on('start', (cmd) => {
                    console.log('[DEBUG] BGM処理 - FFmpeg完全コマンド:');
                    console.log(cmd);
                    console.log('BGM追加処理を開始しました');
                    if (onProgress) onProgress(0.5); // 開始値を50%に変更
                })
                .on('progress', (progress) => {
                    if (onProgress) {
                        // 50%〜100%の範囲で進捗を報告
                        const overallProgress = 0.5 + (progress.percent / 100) * 0.5;
                        onProgress(Math.min(0.99, overallProgress));
                    }
                })
                .on('end', () => {
                    console.log(`BGM追加が完了しました: ${outputPath}`);
                    if (onProgress) {
                        onProgress(1);
                    }

                    const fileSize = fs.existsSync(outputPath) ? fs.statSync(outputPath).size : 0;
                    timer.end({
                        fileSize,
                        outputExists: fs.existsSync(outputPath)
                    });

                    // 一時ファイルを削除（入力と出力が異なる場合のみ）
                    if (videoPath !== outputPath && fs.existsSync(videoPath)) {
                        fs.unlinkSync(videoPath);
                    }

                    resolve(outputPath);
                })
                .on('error', (err) => {
                    console.error('BGM追加エラー:', err);

                    performanceLogger.addLog('addBgmToVideo_error', {
                        error: err.message,
                        videoPath,
                        outputPath
                    });

                    reject(err);
                })
                .run();
        });
    }

    // autoGenerateVideoのsetterを追加
    setAutoGenerateVideo(value) {
        this.autoGenerateVideo = value;
    }

    setYoutubeInfo(youtubeInfo) {
        this.youtubeInfo = youtubeInfo;
    }

    setAutoUploadToYoutube(value) {
        this.autoUploadToYoutube = value;
    }

    /**
     * 冒頭用の2秒間のイントロクリップを作成
     * @param {string} bgPath - 背景画像パス
     * @param {string} outputPath - 出力パス
     * @param {number} duration - 長さ（秒）
     * @returns {Promise<string>} 出力パス
     */
    async _createIntroClip(bgPath, outputPath, duration, options = {}) {
        const timer = performanceLogger.startTimer('createIntroClip');
        performanceLogger.addLog('createIntroClip_start', {
            bgPath,
            outputPath,
            duration
        });

        const layout = getVideoLayout(this.videoFormat);
        const extent = `${layout.width}x${layout.height}`;

        return new Promise((resolve, reject) => {
            const command = ffmpeg();

            const ext = path.extname(bgPath).toLowerCase();
            const isVideo = options.isVideo ?? VIDEO_EXTENSIONS.has(ext);

            if (isVideo) {
                const inputOptions = [];
                if (duration && duration > 0) {
                    inputOptions.push('-t', `${duration}`);
                }
                command.input(bgPath).inputOptions(inputOptions);
            } else {
                command.input(bgPath)
                    .inputOptions(['-loop', '1'])
                    .inputOptions(['-t', `${duration || 2}`]);
            }

            // 無音オーディオトラックを生成
            command.input('anullsrc')
                .inputOptions(['-f', 'lavfi'])
                .inputOptions(['-t', `${duration || 2}`]);

            // 出力設定（可逆圧縮形式）
            command.outputOptions([
                '-c:v', 'libx264',
                '-preset', 'ultrafast',
                '-crf', '23',
                '-pix_fmt', 'yuv420p',
                '-r', '30',
                '-s', extent,
                '-vf', 'fps=30,format=yuv420p',
                '-c:a', 'aac',
                '-b:a', '256k',
                '-threads', '0',
                '-shortest'
            ])
                .output(outputPath)
                .on('start', (cmd) => {
                    console.log('イントロクリップ作成開始:', cmd);
                })
                .on('end', () => {
                    console.log(`イントロクリップ作成完了: ${outputPath}`);

                    const fileSize = fs.existsSync(outputPath) ? fs.statSync(outputPath).size : 0;
                    timer.end({
                        fileSize,
                        outputExists: fs.existsSync(outputPath)
                    });

                    resolve(outputPath);
                })
                .on('error', (err) => {
                    console.error('イントロクリップ作成エラー:', err);

                    performanceLogger.addLog('createIntroClip_error', {
                        error: err.message,
                        bgPath,
                        outputPath
                    });

                    reject(err);
                })
                .run();
        });
    }

    /**
     * キーワードで画像を検索し、ダウンロードして一時ディレクトリに保存
     * @param {string|Object} imageSource - 画像URL、ローカルパス、または画像情報を含むオブジェクト
     * @returns {Promise<string|null>} 保存されたファイルのパス、またはエラーの場合はnull
     */
    async _downloadAndSaveImage(imageSource) {
        // imageSourceが無効な場合は処理をスキップ
        if (!imageSource) {
            console.log('画像ソースが提供されていません。画像処理をスキップします。');
            return null;
        }

        // オブジェクトからimgプロパティを取得
        let imageUrl;
        if (typeof imageSource === 'object' && imageSource !== null) {
            imageUrl = imageSource.img;
        } else {
            imageUrl = imageSource;
        }

        // imageUrlが無効な場合は処理をスキップ
        if (!imageUrl || typeof imageUrl !== 'string' || imageUrl.trim() === '') {
            console.log('有効な画像URLが提供されていません。画像処理をスキップします。');
            return null;
        }

        // ローカルファイルパスの場合はそのまま返す
        if (imageUrl.startsWith('/') || imageUrl.startsWith('C:') || imageUrl.startsWith('c:')) {
            console.log(`ローカルファイルパス: ${imageUrl}`);
            if (fs.existsSync(imageUrl)) {
                return imageUrl;
            } else {
                console.warn(`指定されたファイルが存在しません: ${imageUrl}`);
                return null;
            }
        }

        // URLでない場合は処理をスキップ
        if (!imageUrl.startsWith('http')) {
            console.warn(`有効なURLではありません: ${imageUrl}`);
            return null;
        }

        try {
            console.log(`画像ダウンロード中: ${imageUrl}`);
            const imageResponse = await axios.get(imageUrl, { responseType: 'arraybuffer' });

            // 拡張子を決定 (URLのパス名またはContent-Typeから)
            let extension = '';
            try {
                extension = path.extname(new URL(imageUrl).pathname);
            } catch (urlError) {
                console.warn(`URLの解析エラー (${imageUrl}): ${urlError.message}`);
            }

            const contentType = imageResponse.headers['content-type'];
            if (!extension && contentType && contentType.startsWith('image/')) {
                extension = `.${contentType.split('/')[1]}`;
            }
            if (!extension || extension === '.') {
                extension = '.jpg'; // デフォルト拡張子
            }

            const hash = crypto.randomBytes(8).toString('hex');
            const imagePath = path.join(TEMP_DIR, `image-${hash}${extension}`);
            await fs.promises.writeFile(imagePath, imageResponse.data);
            console.log(`画像をダウンロードしました: ${imagePath}`);
            return imagePath;
        } catch (error) {
            console.error(`画像ダウンロードエラー: ${error.message}`);
            return null;
        }
    }

    /**
     * 最終的なMP4ファイルへのエンコード
     * @param {string} inputPath - 入力動画パス（可逆圧縮形式）
     * @param {string} outputPath - 出力パス（MP4）
     * @param {Function} onProgress - 進捗コールバック
     * @returns {Promise<string>} - 出力ファイルのパス
     */
    async _encodeVideo(inputPath, outputPath, onProgress) {
        const timer = performanceLogger.startTimer('encodeVideo');
        performanceLogger.addLog('encodeVideo_start', {
            inputPath,
            outputPath
        });

        // 出力ファイル名を.mp4に変更
        const finalOutputPath = outputPath.replace(/\.mkv$/, '.mp4');

        const playbackSpeed = (typeof this.playbackSpeed === 'number' && this.playbackSpeed > 0)
            ? this.playbackSpeed
            : 1.0;
        // クリップ作成またはBGM追加の段階で再生速度を適用済みであれば、ここでは調整を行わない
        const speedAlreadyAdjusted = this.clipsAdjustedForSpeed || Math.abs(playbackSpeed - 1.0) <= 0.001;
        console.log(`[DEBUG] 最終エンコード開始 - 入力: ${inputPath}, 出力: ${finalOutputPath}, 速度調整: ${speedAlreadyAdjusted ? '既に適用済み' : '適用予定'}`);

        return new Promise((resolve, reject) => {
            const command = ffmpeg();

            // 入力ファイル
            command.input(inputPath);

            // 音声処理のためのフィルタ設定（基本的には必要なし）
            // speedAlreadyAdjustedがfalseの場合のみ速度調整を適用
            if (!speedAlreadyAdjusted && this.playbackSpeed !== 1.0) {
                console.log(`[DEBUG] 最終エンコード - 会話音声の速度を ${this.playbackSpeed}x に調整します`);
                const speedFilter = `atempo=${this.playbackSpeed}`;
                command.complexFilter([`[0:a]${speedFilter}[a_speed_adjusted]`]);

                // 出力設定（MP4形式）- 速度調整された音声を使用
                command.outputOptions([
                    '-map', '0:v',
                    '-map', '[a_speed_adjusted]',
                    '-c:v', 'libx264',        // H.264ビデオコーデック
                    '-preset', 'fast',        // 高速なプリセットに変更（元は'slow'）
                    '-b:v', '8000k',          // ビットレートを調整（元は12000k）
                    '-g', '60',               // 60フレームごとにキーフレーム
                    '-keyint_min', '60',      // 最小間隔も60に固定
                    '-sc_threshold', '0',     // シーンチェンジによる自動キーフレーム無効化
                    '-pix_fmt', 'yuv420p',    // 汎用的なピクセルフォーマット
                    '-r', '30',               // フレームレート
                    '-c:a', 'aac',            // AACオーディオコーデック
                    '-b:a', '256k',           // オーディオビットレート
                    '-movflags', '+faststart', // Web配信向け最適化
                    '-async', '1',            // オーディオをビデオのタイムスタンプに同期
                    '-threads', '0'           // 利用可能なすべてのCPUコアを使用
                ]);
            } else {
                console.log('[DEBUG] 最終エンコード - 速度調整はスキップします（既に適用済み）');

                // 出力設定（MP4形式）- オリジナル音声をそのまま使用
                command.outputOptions([
                    '-c:v', 'libx264',        // H.264ビデオコーデック
                    '-preset', 'fast',        // 高速なプリセットに変更（元は'slow'）
                    '-b:v', '8000k',          // ビットレートを調整（元は12000k）
                    '-g', '60',               // 60フレームごとにキーフレーム
                    '-keyint_min', '60',      // 最小間隔も60に固定
                    '-sc_threshold', '0',     // シーンチェンジによる自動キーフレーム無効化
                    '-pix_fmt', 'yuv420p',    // 汎用的なピクセルフォーマット
                    '-r', '30',               // フレームレート
                    '-c:a', 'aac',            // AACオーディオコーデック
                    '-b:a', '256k',           // オーディオビットレート
                    '-movflags', '+faststart', // Web配信向け最適化
                    '-async', '1',            // オーディオをビデオのタイムスタンプに同期
                    '-threads', '0'           // 利用可能なすべてのCPUコアを使用
                ]);
            }

            command.output(finalOutputPath)
                .on('start', (cmd) => {
                    console.log('[DEBUG] 最終エンコード - FFmpeg完全コマンド:');
                    console.log(cmd);
                    console.log('最終エンコード処理を開始しました');
                    if (onProgress) onProgress(0); // 0%から始める
                })
                .on('progress', (progress) => {
                    console.log(`エンコード進捗: ${progress.percent}%`);
                    if (onProgress) {
                        onProgress(progress.percent / 100);
                    }
                })
                .on('end', () => {
                    console.log(`最終エンコードが完了しました: ${finalOutputPath}`);
                    if (onProgress) {
                        onProgress(1);
                    }

                    const fileSize = fs.existsSync(finalOutputPath) ? fs.statSync(finalOutputPath).size : 0;
                    timer.end({
                        fileSize,
                        outputExists: fs.existsSync(finalOutputPath)
                    });

                    // 一時ファイルを削除（入力と出力が異なる場合のみ）
                    if (inputPath !== finalOutputPath && fs.existsSync(inputPath)) {
                        fs.unlinkSync(inputPath);
                    }

                    resolve(finalOutputPath);
                })
                .on('error', (err) => {
                    console.error('最終エンコードエラー:', err);

                    performanceLogger.addLog('encodeVideo_error', {
                        error: err.message,
                        inputPath,
                        outputPath: finalOutputPath
                    });

                    reject(err);
                })
                .run();
        });
    }

    /**
     * 出力された動画の品質情報を取得
     * @param {string} videoPath - 動画ファイルパス
     * @returns {Promise<Object>} - 品質情報
     */
    async _getVideoQualityInfo(videoPath) {
        return new Promise((resolve, reject) => {
            ffmpeg.ffprobe(videoPath, (err, metadata) => {
                if (err) {
                    console.error('動画品質情報の取得に失敗しました:', err);
                    resolve({
                        error: '品質情報を取得できませんでした: ' + err.message
                    });
                    return;
                }

                try {
                    // 結果を格納するオブジェクト
                    const qualityInfo = {};

                    // ビデオストリーム情報の取得
                    const videoStream = metadata.streams.find(stream => stream.codec_type === 'video');
                    if (videoStream) {
                        // 解像度
                        qualityInfo.resolution = `${videoStream.width}x${videoStream.height}`;

                        // フレームレート
                        const frameRate = videoStream.r_frame_rate;
                        if (frameRate) {
                            // "30/1" のような形式を計算して小数に変換
                            const [numerator, denominator] = frameRate.split('/');
                            qualityInfo.fps = Math.round((numerator / denominator) * 100) / 100;
                        }

                        // ビデオコーデック
                        qualityInfo.videoCodec = videoStream.codec_name;

                        // ピクセルフォーマット
                        qualityInfo.pixelFormat = videoStream.pix_fmt;

                        // プロファイル
                        qualityInfo.profile = videoStream.profile;

                        // ビットレート（ビデオストリーム）
                        if (videoStream.bit_rate) {
                            qualityInfo.videoBitrate = Math.round(videoStream.bit_rate / 1000) + ' kbps';
                        }
                    }

                    // オーディオストリーム情報の取得
                    const audioStream = metadata.streams.find(stream => stream.codec_type === 'audio');
                    if (audioStream) {
                        // オーディオコーデック
                        qualityInfo.audioCodec = audioStream.codec_name;

                        // サンプリングレート
                        qualityInfo.sampleRate = audioStream.sample_rate + ' Hz';

                        // チャンネル数
                        qualityInfo.channels = audioStream.channels;

                        // ビットレート（オーディオストリーム）
                        if (audioStream.bit_rate) {
                            qualityInfo.audioBitrate = Math.round(audioStream.bit_rate / 1000) + ' kbps';
                        }
                    }

                    // フォーマット情報
                    if (metadata.format) {
                        // 全体のビットレート
                        if (metadata.format.bit_rate) {
                            qualityInfo.totalBitrate = Math.round(metadata.format.bit_rate / 1000) + ' kbps';
                        }

                        // コンテナフォーマット
                        qualityInfo.format = metadata.format.format_name;

                        // デュレーション
                        if (metadata.format.duration) {
                            qualityInfo.duration = parseFloat(metadata.format.duration).toFixed(2) + ' 秒';
                        }

                        // ファイルサイズ（MB）
                        if (metadata.format.size) {
                            qualityInfo.fileSize = (metadata.format.size / (1024 * 1024)).toFixed(2) + ' MB';
                        }
                    }

                    console.log('[品質情報]', JSON.stringify(qualityInfo, null, 2));
                    resolve(qualityInfo);
                } catch (error) {
                    console.error('品質情報の解析中にエラーが発生しました:', error);
                    resolve({
                        error: '品質情報の解析に失敗しました: ' + error.message
                    });
                }
            });
        });
    }

    async _createInsertedVideoClip(file, outputPath, fallbackBackground, onProgress) {
        const duration = Math.max(0, Number(file.duration) || 0);
        if (!duration || !fs.existsSync(file.path)) {
            throw new Error('挿入動画の生成に失敗しました: 無効なパラメータ');
        }

        const trimStart = Math.max(0, Number(file.videoStartOffset) || 0);
        const trimEnd = Math.max(trimStart, Number(file.videoEndOffset) || trimStart);
        const trimDuration = Math.max(0, trimEnd - trimStart);

        const clipTimer = performanceLogger.startTimer('createInsertedVideoClip');
        performanceLogger.addLog('createInsertedVideoClip_start', {
            videoPath: file.path,
            trimStart,
            trimEnd,
            trimDuration,
            outputPath
        });

        let tempOutput = outputPath;
        let cleanupTemp = false;

        try {
            tempOutput = path.join(TEMP_DIR, `insert_trim_${Date.now()}.mkv`);
            await this._trimVideoSegment(file.path, tempOutput, trimStart, trimDuration, true, onProgress);
            cleanupTemp = true;

            const hasAudio = await hasAudioStream(tempOutput);
            if (!hasAudio) {
                const withAudioOutput = path.join(TEMP_DIR, `insert_with_audio_${Date.now()}.mkv`);
                await this._addSilentAudio(tempOutput, withAudioOutput, fallbackBackground, duration);
                fs.unlinkSync(tempOutput);
                tempOutput = withAudioOutput;
            }

            if (cleanupTemp) {
                fs.renameSync(tempOutput, outputPath);
            }

            clipTimer.end({
                outputPath,
                duration,
                insertedVideo: file.path
            });

            return { outputPath, duration };
        } catch (error) {
            if (cleanupTemp && fs.existsSync(tempOutput)) {
                try { fs.unlinkSync(tempOutput); } catch (_) { }
            }
            throw error;
        }
    }

    async _trimVideoSegment(inputPath, outputPath, start, duration, includeAudio, onProgress) {
        return new Promise((resolve, reject) => {
            const layout = getVideoLayout(this.videoFormat);
            const command = ffmpeg();
            command.input(inputPath);

            if (start > 0) {
                command.inputOptions(['-ss', `${start}`]);
            }

            if (duration > 0) {
                command.outputOptions(['-t', `${duration}`]);
            }

            command.videoFilters(`scale=${layout.width}:${layout.height}:force_original_aspect_ratio=decrease,pad=${layout.width}:${layout.height}:(ow-iw)/2:(oh-ih)/2`);

            const videoCodecOptions = [
                '-c:v', 'libx264',
                '-preset', 'ultrafast',
                '-crf', '18',
                '-pix_fmt', 'yuv420p',
                '-r', '30'
            ];

            const audioOptions = includeAudio
                ? ['-c:a', 'aac', '-b:a', '256k', '-ar', '44100', '-ac', '2']
                : ['-an'];

            command
                .outputOptions([...videoCodecOptions, ...audioOptions])
                .output(outputPath)
                .on('start', (cmd) => {
                    console.log('[DEBUG] Trim video command:', cmd);
                })
                .on('progress', (progress) => {
                    if (typeof onProgress === 'function') {
                        onProgress(Math.min(1, (progress.percent || 0) / 100));
                    }
                })
                .on('end', () => {
                    resolve();
                })
                .on('error', (err) => {
                    console.error('動画セグメントの切り出しに失敗しました:', err);
                    reject(err);
                })
                .run();
        });
    }

    async _addSilentAudio(inputPath, outputPath, fallbackBackground, duration) {
        return new Promise((resolve, reject) => {
            const command = ffmpeg();
            command.input(inputPath);
            command.input('anullsrc=channel_layout=stereo:sample_rate=44100')
                .inputOptions(['-f', 'lavfi']);

            command
                .outputOptions([
                    '-t', `${duration}`,
                    '-shortest',
                    '-c:v', 'copy',
                    '-c:a', 'aac',
                    '-b:a', '192k'
                ])
                .output(outputPath)
                .on('start', (cmd) => {
                    console.log('[DEBUG] Adding silent audio:', cmd);
                })
                .on('end', () => {
                    resolve();
                })
                .on('error', async (err) => {
                    console.error('静音オーディオ追加に失敗しました:', err);
                    try {
                        const fallbackClip = await this._createGapClip(duration, outputPath, {
                            backgroundPath: fallbackBackground,
                            fallbackBackground
                        });
                        resolve(fallbackClip);
                    } catch (e) {
                        reject(err);
                    }
                })
                .run();
        });
    }
}

// getImageDimensions関数を追加
async function getImageDimensions(imagePath) {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(imagePath, (err, metadata) => {
            if (err) {
                reject(err);
                return;
            }
            const { width, height } = metadata.streams[0];
            resolve({ width, height });
        });
    });
}

// SVGをPNGに変換する関数を追加
async function convertSvgToPng(svgPath) {
    const tempPngPath = path.join(TEMP_DIR, `svg-fallback-${Date.now()}.png`);

    try {
        console.log(`[DEBUG] SVGファイルを検出: ${svgPath}、PNG形式に変換します`);

        // ImageMagickを使用してSVGをPNGに変換
        return new Promise((resolve, reject) => {
            const { exec } = require('child_process');

            // ImageMagickのconvertコマンドを実行
            const command = `"${MAGICK_BIN}" "${svgPath}" -background white -alpha remove -resize 1920x1080 "${tempPngPath}"`;

            exec(command, (error, stdout, stderr) => {
                if (error) {
                    console.error(`[ERROR] ImageMagick変換エラー: ${error.message}`);
                    // 変換失敗時はデフォルト画像を生成
                    createDefaultImage(tempPngPath).then(resolve).catch(reject);
                    return;
                }

                if (stderr) {
                    console.log(`[INFO] ImageMagick stderr: ${stderr}`);
                }

                console.log(`[SUCCESS] SVGをPNGに変換しました: ${tempPngPath}`);
                resolve(tempPngPath);
            });
        });
    } catch (error) {
        console.error(`[ERROR] SVG→PNG変換エラー: ${error.message}`);
        // エラー時はデフォルト画像を作成
        return await createDefaultImage(tempPngPath);
    }
}

// デフォルト画像の作成（エラーメッセージ入り）
async function createDefaultImage(outputPath) {
    return new Promise((resolve, reject) => {
        console.log(`[DEBUG] デフォルト画像を生成します: ${outputPath}`);

        const { exec } = require('child_process');

        // ImageMagickでエラーメッセージ入りの画像を生成
        const command = `"${MAGICK_BIN}" -size 1920x1080 xc:#333333 -fill white -gravity center ` +
            `-pointsize 48 -annotate 0 "SVG変換エラー" ` +
            `-pointsize 24 -annotate +0+60 "代替画像が表示されています" "${outputPath}"`;

        exec(command, (error, stdout, stderr) => {
            if (error) {
                console.error(`[ERROR] デフォルト画像生成エラー: ${error.message}`);

                // ImageMagickも失敗した場合はffmpegを使用（以前の実装）
                const command = ffmpeg()
                    .input('color=c=black:s=1920x1080:d=1') // 黒い背景を生成
                    .inputFormat('lavfi')
                    .frames(1)
                    .output(outputPath)
                    .on('end', () => {
                        console.log(`[SUCCESS] ffmpegでデフォルト画像を作成しました: ${outputPath}`);
                        resolve(outputPath);
                    })
                    .on('error', (err) => {
                        console.error(`[ERROR] ffmpegでのデフォルト画像作成失敗: ${err.message}`);
                        reject(err);
                    });

                command.run();
                return;
            }

            console.log(`[SUCCESS] ImageMagickでデフォルト画像を作成しました: ${outputPath}`);
            resolve(outputPath);
        });
    });
}

module.exports = new TTSServiceMain();
