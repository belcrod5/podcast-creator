const fs = require('fs');
const os = require('os');
const path = require('path');
const { normalizeScriptItems } = require('./podcast-script');

const SAVE_SCHEMA_VERSION = 1;
const SAVE_ROOT_DIR = '.podcast-creator';
const SAVE_SUB_DIR = 'saves';
const SAVE_FILE_SUFFIX = '.podcast-save.json';

const DEFAULT_INSERT_VIDEO_PATH = 'videos/output.mp4';
const DEFAULT_INSERT_VIDEO_MAPPING_PATH = `${DEFAULT_INSERT_VIDEO_PATH}.json`;
const TEMP_CACHE_ROOT = path.join(os.tmpdir(), 'aivis-audio');

const SCRIPT_PATH_FIELDS = [
    'img',
    'localPath',
    'videoPath',
    'path',
    'insert_video',
    'thumbnailPath'
];

const isPlainObject = (value) => (
    !!value && typeof value === 'object' && !Array.isArray(value)
);

const toPosixPath = (value) => String(value || '').replace(/\\/g, '/');

const ensureString = (value, fallback = '') => {
    if (value === null || value === undefined) return fallback;
    return String(value);
};

const normalizeTags = (value) => {
    if (Array.isArray(value)) return value.join(',');
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value;
    return String(value);
};

const normalizeBoolean = (value, fallback) => {
    if (typeof value === 'boolean') return value;
    return fallback;
};

const normalizeNumber = (value, fallback, { min = null, max = null } = {}) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    if (Number.isFinite(min) && n < min) return min;
    if (Number.isFinite(max) && n > max) return max;
    return n;
};

const getSaveDir = (workDir) => path.join(workDir, SAVE_ROOT_DIR, SAVE_SUB_DIR);

const sanitizeSlug = (value) => {
    const slug = ensureString(value, 'podcast')
        .trim()
        .replace(/[^\w\u3040-\u30ff\u4e00-\u9fff.-]+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 48);
    return slug || 'podcast';
};

const createSaveId = (savedAt, title = '') => {
    const date = new Date(savedAt);
    const stamp = Number.isNaN(date.getTime())
        ? new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
        : date.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    const slug = sanitizeSlug(title);
    const random = Math.random().toString(36).slice(2, 8);
    return `${stamp}-${slug}-${random}`;
};

const getSaveFileName = (record) => `${record.id}${SAVE_FILE_SUFFIX}`;

const resolveSaveFilePath = ({ workDir, id, fileName, filePath } = {}) => {
    if (!workDir || typeof workDir !== 'string') return null;
    const saveDir = getSaveDir(workDir);

    if (typeof filePath === 'string' && filePath.trim()) {
        const trimmed = filePath.trim();
        return path.isAbsolute(trimmed) ? trimmed : path.join(workDir, trimmed);
    }

    if (typeof fileName === 'string' && fileName.trim()) {
        return path.join(saveDir, fileName.trim());
    }

    if (typeof id === 'string' && id.trim()) {
        const normalized = id.trim().endsWith(SAVE_FILE_SUFFIX)
            ? id.trim()
            : `${id.trim()}${SAVE_FILE_SUFFIX}`;
        return path.join(saveDir, normalized);
    }

    return null;
};

const parseScriptFromInput = ({ script, scriptText, speakerId, language }) => {
    if (Array.isArray(script)) {
        return normalizeScriptItems(script, { defaultInsertVideoPath: DEFAULT_INSERT_VIDEO_PATH });
    }

    if (typeof scriptText === 'string' && scriptText.trim()) {
        try {
            const parsed = JSON.parse(scriptText);
            if (Array.isArray(parsed)) {
                return normalizeScriptItems(parsed, { defaultInsertVideoPath: DEFAULT_INSERT_VIDEO_PATH });
            }
        } catch (_) {
            // ignore parse error and fallback to plain text item
        }

        const fallbackItem = {
            text: scriptText,
            id: ensureString(speakerId, ''),
            language: ensureString(language, 'ja') || 'ja'
        };
        return [fallbackItem];
    }

    return [];
};

const normalizeRuntimeOverrides = (raw = {}) => {
    const source = isPlainObject(raw) ? raw : {};
    return {
        videoFormat: ensureString(source.videoFormat, 'landscape') || 'landscape',
        playbackSpeed: normalizeNumber(source.playbackSpeed, 1, { min: 0.1, max: 2 }),
        autoUpload: normalizeBoolean(source.autoUpload, true),
        youtubeToken: ensureString(source.youtubeToken, ''),
        speakerVideoPrefix: ensureString(source.speakerVideoPrefix, ''),
        bgm: ensureString(source.bgm, ''),
        bgmPath: ensureString(source.bgmPath, ''),
        bgmVolume: normalizeNumber(source.bgmVolume, 0.2, { min: 0, max: 1 }),
        captionsEnabled: normalizeBoolean(source.captionsEnabled, true),
        introBgVideo: ensureString(source.introBgVideo, ''),
        backgroundText: ensureString(source.backgroundText, ''),
        language: ensureString(source.language, '')
    };
};

const buildCanonicalRequest = (input = {}) => {
    const source = isPlainObject(input) ? input : {};
    const baseRequest = isPlainObject(source.request) ? source.request : source;
    const baseYoutube = isPlainObject(baseRequest.youtube)
        ? baseRequest.youtube
        : (isPlainObject(source.youtube) ? source.youtube : {});

    const script = parseScriptFromInput({
        script: Array.isArray(baseRequest.script) ? baseRequest.script : source.script,
        scriptText: baseRequest.scriptText ?? source.scriptText,
        speakerId: baseRequest.speakerId ?? source.speakerId,
        language: baseRequest.language ?? source.language
    });

    const runtimeOverrides = normalizeRuntimeOverrides(
        isPlainObject(baseRequest.runtimeOverrides)
            ? baseRequest.runtimeOverrides
            : source.runtimeOverrides
    );

    return {
        preset: ensureString(baseRequest.preset ?? source.preset, ''),
        script,
        youtube: {
            title: ensureString(baseYoutube.title, ''),
            description: ensureString(baseYoutube.description, ''),
            tags: normalizeTags(baseYoutube.tags),
            category: ensureString(baseYoutube.category ?? baseYoutube.categoryId, '22') || '22',
            thumbnailPath: ensureString(baseYoutube.thumbnailPath, ''),
            fixedDescription: ensureString(baseYoutube.fixedDescription, '')
        },
        insertVideoMapping: ensureString(
            baseRequest.insertVideoMapping ?? source.insertVideoMapping,
            DEFAULT_INSERT_VIDEO_MAPPING_PATH
        ) || DEFAULT_INSERT_VIDEO_MAPPING_PATH,
        runtimeOverrides
    };
};

const validateCanonicalRequest = (request) => {
    const errors = [];
    const target = isPlainObject(request) ? request : {};

    if (!Array.isArray(target.script) || target.script.length === 0) {
        errors.push('script must be a non-empty array');
    }

    if (!isPlainObject(target.youtube)) {
        errors.push('youtube must be an object');
    } else {
        if (!Object.prototype.hasOwnProperty.call(target.youtube, 'title')) {
            errors.push('youtube.title is required');
        }
        if (!Object.prototype.hasOwnProperty.call(target.youtube, 'description')) {
            errors.push('youtube.description is required');
        }
    }

    if (!isPlainObject(target.runtimeOverrides)) {
        errors.push('runtimeOverrides must be an object');
    }

    return {
        valid: errors.length === 0,
        errors
    };
};

const isUrlLike = (value) => /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value);

const isCustomSchemePath = (value) => (
    typeof value === 'string'
    && (value.startsWith('local-media:') || value.startsWith('local-image:'))
);

const isTempCachePath = (filePath) => {
    const absolute = path.resolve(filePath);
    const tempRoot = path.resolve(TEMP_CACHE_ROOT);
    return absolute === tempRoot || absolute.startsWith(`${tempRoot}${path.sep}`);
};

const copyTempAsset = (sourcePath, { workDir, saveId }) => {
    const source = path.resolve(sourcePath);
    const ext = path.extname(source);
    const baseName = path.basename(source, ext);
    const importDir = path.join(workDir, SAVE_ROOT_DIR, 'assets', 'imported', saveId);
    fs.mkdirSync(importDir, { recursive: true });

    let index = 0;
    let nextPath = path.join(importDir, `${baseName}${ext}`);
    while (fs.existsSync(nextPath)) {
        index += 1;
        nextPath = path.join(importDir, `${baseName}-${index}${ext}`);
    }

    fs.copyFileSync(source, nextPath);
    return toPosixPath(nextPath);
};

const normalizePathField = (value, { workDir, saveId, warnings, field }) => {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    if (!trimmed) return trimmed;
    if (isUrlLike(trimmed) || isCustomSchemePath(trimmed)) return trimmed;
    if (!path.isAbsolute(trimmed)) {
        const candidate = path.resolve(workDir, trimmed);
        if (fs.existsSync(candidate) && !fs.statSync(candidate).isDirectory()) {
            return toPosixPath(candidate);
        }
        return toPosixPath(trimmed);
    }

    const absolute = path.resolve(trimmed);
    if (!fs.existsSync(absolute) || fs.statSync(absolute).isDirectory()) {
        warnings.push(`missing asset (${field}): ${trimmed}`);
        return trimmed;
    }

    if (isTempCachePath(absolute)) {
        return copyTempAsset(absolute, { workDir, saveId });
    }

    return toPosixPath(absolute);
};

const normalizeAssetPaths = (request, { workDir, saveId } = {}) => {
    const canonical = buildCanonicalRequest({ request });
    const warnings = [];
    if (!workDir || typeof workDir !== 'string') {
        return { request: canonical, warnings };
    }

    const next = JSON.parse(JSON.stringify(canonical));
    if (isPlainObject(next.youtube)) {
        next.youtube.thumbnailPath = normalizePathField(next.youtube.thumbnailPath, {
            workDir,
            saveId,
            warnings,
            field: 'youtube.thumbnailPath'
        });
    }

    next.insertVideoMapping = normalizePathField(next.insertVideoMapping, {
        workDir,
        saveId,
        warnings,
        field: 'insertVideoMapping'
    });

    if (isPlainObject(next.runtimeOverrides) && Object.prototype.hasOwnProperty.call(next.runtimeOverrides, 'bgmPath')) {
        next.runtimeOverrides.bgmPath = normalizePathField(next.runtimeOverrides.bgmPath, {
            workDir,
            saveId,
            warnings,
            field: 'runtimeOverrides.bgmPath'
        });
    }

    if (Array.isArray(next.script)) {
        next.script = next.script.map((item, index) => {
            if (!isPlainObject(item)) return item;
            const updated = { ...item };
            SCRIPT_PATH_FIELDS.forEach((field) => {
                if (!Object.prototype.hasOwnProperty.call(updated, field)) return;
                updated[field] = normalizePathField(updated[field], {
                    workDir,
                    saveId,
                    warnings,
                    field: `script[${index}].${field}`
                });
            });
            return updated;
        });
    }

    return { request: next, warnings };
};

const normalizeResult = (result = {}) => {
    const target = isPlainObject(result) ? result : {};
    const normalized = {};

    if (typeof target.status === 'string' && target.status.trim()) {
        normalized.status = target.status.trim();
    }
    if (typeof target.outputPath === 'string' && target.outputPath.trim()) {
        normalized.outputPath = target.outputPath.trim();
    }
    if (typeof target.completedAt === 'string' && target.completedAt.trim()) {
        normalized.completedAt = target.completedAt.trim();
    }
    if (typeof target.failedAt === 'string' && target.failedAt.trim()) {
        normalized.failedAt = target.failedAt.trim();
    }
    if (typeof target.error === 'string' && target.error.trim()) {
        normalized.error = target.error.trim();
    }

    return normalized;
};

const createSaveRecord = ({
    source = 'unknown',
    request,
    workDir,
    savedAt = new Date().toISOString(),
    result = { status: 'processing' }
} = {}) => {
    const canonical = buildCanonicalRequest({ request });
    const validation = validateCanonicalRequest(canonical);
    if (!validation.valid) {
        throw new Error(`invalid canonical request: ${validation.errors.join(', ')}`);
    }

    const saveId = createSaveId(savedAt, canonical.youtube?.title || canonical.preset);
    const normalizedAssets = normalizeAssetPaths(canonical, { workDir, saveId });
    const normalizedResult = normalizeResult(result);

    const record = {
        schemaVersion: SAVE_SCHEMA_VERSION,
        id: saveId,
        savedAt,
        source: ensureString(source, 'unknown'),
        workDir: ensureString(workDir, ''),
        request: normalizedAssets.request,
        assetSnapshot: {
            warnings: normalizedAssets.warnings
        },
        result: normalizedResult
    };

    return {
        record,
        fileName: getSaveFileName(record)
    };
};

const writeSaveRecord = ({ workDir, record, fileName } = {}) => {
    if (!workDir || typeof workDir !== 'string') {
        throw new Error('workDir is required');
    }
    if (!isPlainObject(record)) {
        throw new Error('record is required');
    }

    const targetFileName = ensureString(fileName, getSaveFileName(record));
    const dir = getSaveDir(workDir);
    fs.mkdirSync(dir, { recursive: true });

    const filePath = path.join(dir, targetFileName);
    fs.writeFileSync(filePath, JSON.stringify(record, null, 2), 'utf8');
    return {
        filePath,
        fileName: targetFileName
    };
};

const listSaveRecords = ({ workDir, limit = 50 } = {}) => {
    if (!workDir || typeof workDir !== 'string') return [];
    const dir = getSaveDir(workDir);
    if (!fs.existsSync(dir)) return [];

    const entries = fs.readdirSync(dir)
        .filter((name) => name.endsWith(SAVE_FILE_SUFFIX))
        .map((name) => {
            const filePath = path.join(dir, name);
            let stat = null;
            try {
                stat = fs.statSync(filePath);
            } catch (_) {
                stat = null;
            }
            return { name, filePath, mtimeMs: stat?.mtimeMs || 0 };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs);

    const normalizedLimit = Math.max(1, Math.min(200, Number(limit) || 50));
    return entries.slice(0, normalizedLimit).map((entry) => {
        try {
            const raw = fs.readFileSync(entry.filePath, 'utf8');
            const record = JSON.parse(raw);
            return {
                id: ensureString(record.id, ''),
                fileName: entry.name,
                filePath: entry.filePath,
                savedAt: ensureString(record.savedAt, ''),
                source: ensureString(record.source, ''),
                title: ensureString(record?.request?.youtube?.title, ''),
                status: ensureString(record?.result?.status, '')
            };
        } catch (_) {
            return {
                id: '',
                fileName: entry.name,
                filePath: entry.filePath,
                savedAt: '',
                source: '',
                title: '',
                status: ''
            };
        }
    });
};

const loadSaveRecord = ({ workDir, id, fileName, filePath } = {}) => {
    if (!workDir || typeof workDir !== 'string') {
        throw new Error('workDir is required');
    }

    let targetPath = resolveSaveFilePath({ workDir, id, fileName, filePath });
    if (!targetPath) {
        const listed = listSaveRecords({ workDir, limit: 1 });
        if (!listed.length) {
            throw new Error('save record not found');
        }
        targetPath = listed[0].filePath;
    }

    if (!fs.existsSync(targetPath)) {
        throw new Error(`save record not found: ${targetPath}`);
    }

    const raw = fs.readFileSync(targetPath, 'utf8');
    const record = JSON.parse(raw);
    return {
        record,
        filePath: targetPath,
        fileName: path.basename(targetPath)
    };
};

const updateSaveRecordResult = ({ workDir, id, fileName, filePath, result } = {}) => {
    const loaded = loadSaveRecord({ workDir, id, fileName, filePath });
    const record = isPlainObject(loaded.record) ? loaded.record : {};
    const currentResult = isPlainObject(record.result) ? record.result : {};
    const nextResult = {
        ...currentResult,
        ...normalizeResult(result)
    };
    const nextRecord = {
        ...record,
        result: nextResult
    };

    fs.writeFileSync(loaded.filePath, JSON.stringify(nextRecord, null, 2), 'utf8');
    return {
        record: nextRecord,
        filePath: loaded.filePath,
        fileName: loaded.fileName
    };
};

module.exports = {
    SAVE_SCHEMA_VERSION,
    SAVE_ROOT_DIR,
    SAVE_SUB_DIR,
    SAVE_FILE_SUFFIX,
    DEFAULT_INSERT_VIDEO_PATH,
    DEFAULT_INSERT_VIDEO_MAPPING_PATH,
    buildCanonicalRequest,
    validateCanonicalRequest,
    normalizeAssetPaths,
    createSaveRecord,
    writeSaveRecord,
    listSaveRecords,
    loadSaveRecord,
    updateSaveRecordResult,
    getSaveDir
};
