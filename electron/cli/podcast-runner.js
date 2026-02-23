const fs = require('fs');
const path = require('path');
const {
    normalizeScriptItems,
    adjustInsertVideoTimingsCore,
    buildInsertVideoMappingPlan
} = require('../../shared/podcast-script');
const {
    buildCanonicalRequest,
    createSaveRecord,
    writeSaveRecord,
    loadSaveRecord,
    updateSaveRecordResult
} = require('../../shared/podcast-save-data');

const PRESET_CONFIG_PATH = 'data/podcastcreator-preset.json';
const DEFAULT_INSERT_VIDEO_PATH = 'videos/output.mp4';
const DEFAULT_INSERT_VIDEO_MAPPING_PATH = `${DEFAULT_INSERT_VIDEO_PATH}.json`;

const PODCAST_REQUIRED_FIELDS = ['preset', 'script', 'youtube'];
const YOUTUBE_REQUIRED_FIELDS = ['title', 'description', 'tags', 'category'];
const PRESET_REQUIRED_FIELDS = [
    'lang',
    'bgm',
    'introBgVideo',
    'videoFormat',
    'captionsEnabled',
    'bgmVolume',
    'youtubeToken',
    'fixedDescription',
    'playbackSpeed',
    'speakerVideoPrefix',
    'autoUpload'
];

const isPlainObject = (value) => (
    !!value && typeof value === 'object' && !Array.isArray(value)
);

const getMissingKeys = (value, keys) => {
    const target = isPlainObject(value) ? value : {};
    return keys.filter((key) => !Object.prototype.hasOwnProperty.call(target, key));
};

const parseCliArgs = (argv = []) => {
    const args = Array.isArray(argv) ? argv : [];
    const readValue = (flag) => {
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

    return {
        podcastPath: readValue('--podcast'),
        resumePath: readValue('--resume'),
        workDir: readValue('--workdir')
    };
};

const resolveWorkPath = (targetPath, workDir) => {
    if (!targetPath || !workDir) return null;
    const normalizedTarget = (typeof targetPath === 'string') ? targetPath : String(targetPath);
    const trimmed = normalizedTarget.trim();
    if (!trimmed) return null;

    return path.isAbsolute(trimmed) ? trimmed : path.join(workDir, trimmed);
};

const readJsonFile = (targetPath, workDir, label = 'JSON') => {
    const resolvedPath = resolveWorkPath(targetPath, workDir);
    if (!resolvedPath) {
        throw new Error(`${label} path is missing`);
    }
    if (!fs.existsSync(resolvedPath)) {
        throw new Error(`${label} file not found: ${resolvedPath}`);
    }
    const raw = fs.readFileSync(resolvedPath, 'utf8');
    try {
        return { data: JSON.parse(raw), path: resolvedPath };
    } catch (error) {
        throw new Error(`${label} parse failed: ${error.message}`);
    }
};

const normalizeTags = (value) => {
    if (Array.isArray(value)) {
        return value.join(',');
    }
    if (typeof value === 'string') {
        return value;
    }
    if (value === null || value === undefined) {
        return '';
    }
    return String(value);
};

const normalizeLanguage = (value) => (
    typeof value === 'string' && value.toLowerCase() === 'en' ? 'en' : 'ja'
);

const resolveAssetsRoot = (workDir) => {
    if (!workDir) return null;
    return workDir;
};

const resolveBgmPath = (bgmValue, workDir) => {
    if (typeof bgmValue !== 'string') return '';
    const trimmed = bgmValue.trim();
    if (!trimmed) return '';
    if (path.isAbsolute(trimmed)) return trimmed;
    const assetsRoot = resolveAssetsRoot(workDir);
    if (!assetsRoot) return trimmed;
    return path.join(assetsRoot, 'backgrounds', trimmed);
};

const buildYoutubeDescription = (base, presetFixed, youtubeFixed) => {
    let combined = (typeof base === 'string') ? base : '';
    const append = (value) => {
        if (typeof value !== 'string' || value === '') return;
        combined = combined ? `${combined}\n${value}` : value;
    };
    append(presetFixed);
    append(youtubeFixed);
    return combined;
};

const collectSpeakerIds = (scriptItems) => {
    const ids = [];
    (scriptItems || []).forEach((item) => {
        if (!item || typeof item !== 'object') return;
        if (item.id) ids.push(item.id);
        if (item.speakerId) ids.push(item.speakerId);
    });
    return [...new Set(ids)];
};

const resolvePresetList = (presetConfig) => {
    if (Array.isArray(presetConfig)) return presetConfig;
    if (presetConfig && Array.isArray(presetConfig.presets)) return presetConfig.presets;
    return null;
};

const formatProgress = (value) => {
    if (!Number.isFinite(value)) return String(value ?? '');
    return `${Math.round(value * 100)}%`;
};

const resolvePodcastInput = ({ podcastPath, resumePath, workDir }) => {
    const normalizedResumePath = (typeof resumePath === 'string' && resumePath.trim())
        ? resumePath.trim()
        : '';
    if (normalizedResumePath) {
        const loaded = normalizedResumePath === 'latest'
            ? loadSaveRecord({ workDir })
            : loadSaveRecord({ workDir, filePath: normalizedResumePath });

        const request = isPlainObject(loaded?.record?.request) ? loaded.record.request : {};
        const youtube = isPlainObject(request.youtube) ? request.youtube : {};
        const runtimeOverrides = isPlainObject(request.runtimeOverrides) ? request.runtimeOverrides : {};

        return {
            podcast: {
                preset: request.preset,
                script: Array.isArray(request.script) ? request.script : [],
                youtube: {
                    title: youtube.title ?? '',
                    description: youtube.description ?? '',
                    tags: youtube.tags ?? '',
                    category: youtube.category ?? youtube.categoryId ?? '22',
                    thumbnailPath: youtube.thumbnailPath ?? '',
                    fixedDescription: youtube.fixedDescription ?? ''
                },
                insertVideoMapping: request.insertVideoMapping ?? DEFAULT_INSERT_VIDEO_MAPPING_PATH,
                runtimeOverrides
            },
            loadedSave: loaded
        };
    }

    const normalizedPodcastPath = (typeof podcastPath === 'string' && podcastPath.trim()) ? podcastPath.trim() : '';
    if (!normalizedPodcastPath) {
        throw new Error('Missing podcast JSON. Pass --podcast /path/to/podcast.json or --resume latest');
    }
    const podcastResult = readJsonFile(normalizedPodcastPath, workDir, 'podcast.json');
    const podcast = podcastResult.data;
    return {
        podcast,
        loadedSave: null
    };
};

const runPodcastRunner = async ({
    podcastPath,
    resumePath,
    workDir,
    ttsService,
    log = console
} = {}) => {
    let saveRecordRef = null;
    let normalizedWorkDir = null;
    try {
        normalizedWorkDir = (typeof workDir === 'string' && workDir.trim()) ? workDir.trim() : null;
        if (!normalizedWorkDir) {
            throw new Error('Missing workdir. Set PODCAST_CREATOR_WORKDIR or pass --workdir.');
        }
        if (!ttsService) {
            throw new Error('ttsService is not available');
        }

        process.env.PODCAST_CREATOR_WORKDIR = normalizedWorkDir;
        if (typeof ttsService.setWorkDir === 'function') {
            ttsService.setWorkDir(normalizedWorkDir);
        }

        const { podcast, loadedSave } = resolvePodcastInput({
            podcastPath,
            resumePath,
            workDir: normalizedWorkDir
        });
        if (loadedSave?.filePath) {
            log.info?.(`[resume] loaded save: ${loadedSave.filePath}`);
        }

        const missingPodcastFields = getMissingKeys(podcast, PODCAST_REQUIRED_FIELDS);
        if (missingPodcastFields.length) {
            throw new Error(`Missing podcast fields: ${missingPodcastFields.join(', ')}`);
        }

        if (!Array.isArray(podcast.script) || podcast.script.length === 0) {
            throw new Error('Invalid script: script must be a non-empty array');
        }

        if (!isPlainObject(podcast.youtube)) {
            throw new Error('Invalid youtube: youtube must be an object');
        }
        const missingYoutubeFields = getMissingKeys(podcast.youtube, YOUTUBE_REQUIRED_FIELDS);
        if (missingYoutubeFields.length) {
            throw new Error(`Missing youtube fields: ${missingYoutubeFields.join(', ')}`);
        }

        const runtimeOverrides = isPlainObject(podcast.runtimeOverrides) ? podcast.runtimeOverrides : {};

        const presetConfig = readJsonFile(PRESET_CONFIG_PATH, normalizedWorkDir, 'preset config');
        const presets = resolvePresetList(presetConfig.data);
        if (!presets) {
            throw new Error('Invalid preset config format');
        }
        const presetId = podcast.preset;
        const preset = presets.find((entry) => entry && entry.id === presetId);
        if (!preset) {
            throw new Error(`Missing preset id: ${presetId}`);
        }
        const missingPresetFields = getMissingKeys(preset, PRESET_REQUIRED_FIELDS);
        if (missingPresetFields.length) {
            throw new Error(`Missing preset fields: ${missingPresetFields.join(', ')}`);
        }

        const effectiveLanguage = normalizeLanguage(runtimeOverrides.language || preset.lang);
        const effectiveVideoFormat = (typeof runtimeOverrides.videoFormat === 'string' && runtimeOverrides.videoFormat.trim())
            ? runtimeOverrides.videoFormat.trim()
            : preset.videoFormat;
        const effectivePlaybackSpeed = Number.isFinite(Number(runtimeOverrides.playbackSpeed))
            ? Math.min(Math.max(Number(runtimeOverrides.playbackSpeed), 0.1), 2.0)
            : preset.playbackSpeed;
        const effectiveAutoUpload = (typeof runtimeOverrides.autoUpload === 'boolean')
            ? runtimeOverrides.autoUpload
            : preset.autoUpload;
        const effectiveYoutubeToken = (typeof runtimeOverrides.youtubeToken === 'string' && runtimeOverrides.youtubeToken.trim())
            ? runtimeOverrides.youtubeToken.trim()
            : ((typeof preset.youtubeToken === 'string' && preset.youtubeToken.trim()) ? preset.youtubeToken.trim() : '');
        const effectiveSpeakerVideoPrefix = (typeof runtimeOverrides.speakerVideoPrefix === 'string')
            ? runtimeOverrides.speakerVideoPrefix
            : preset.speakerVideoPrefix;
        const effectiveBgmName = (typeof runtimeOverrides.bgm === 'string' && runtimeOverrides.bgm.trim())
            ? runtimeOverrides.bgm.trim()
            : preset.bgm;
        const effectiveBgmPathOverride = (typeof runtimeOverrides.bgmPath === 'string' && runtimeOverrides.bgmPath.trim())
            ? runtimeOverrides.bgmPath.trim()
            : '';
        const effectiveBgmVolume = Number.isFinite(Number(runtimeOverrides.bgmVolume))
            ? Math.min(Math.max(Number(runtimeOverrides.bgmVolume), 0), 1)
            : preset.bgmVolume;
        const effectiveCaptionsEnabled = (typeof runtimeOverrides.captionsEnabled === 'boolean')
            ? runtimeOverrides.captionsEnabled
            : preset.captionsEnabled;
        const effectiveIntroBgVideo = (typeof runtimeOverrides.introBgVideo === 'string')
            ? runtimeOverrides.introBgVideo.trim()
            : preset.introBgVideo;

        if (typeof ttsService.setYoutubeTokenFile === 'function' && effectiveYoutubeToken) {
            ttsService.setYoutubeTokenFile(effectiveYoutubeToken);
        }

        if (effectiveAutoUpload) {
            if (typeof ttsService.ensureYoutubeAuthOrThrow === 'function') {
                await ttsService.ensureYoutubeAuthOrThrow();
            } else if (typeof ttsService.checkYoutubeAuth === 'function') {
                const isAuthValid = await ttsService.checkYoutubeAuth();
                if (!isAuthValid) {
                    throw new Error('YouTube認証エラー: 認証済みトークンが見つからないか、有効期限が切れています。');
                }
            }
        }

        const speakerIds = collectSpeakerIds(podcast.script);
        if (speakerIds.length) {
            const lang = effectiveLanguage;
            let validIds = [];
            if (lang === 'en') {
                const englishSpeakers = await ttsService.getEnglishSpeakers();
                validIds = Array.isArray(englishSpeakers)
                    ? englishSpeakers.filter((id) => typeof id === 'string' && id.trim())
                    : [];
            } else {
                const speakers = await ttsService.getSpeakers();
                validIds = Array.isArray(speakers)
                    ? speakers.flatMap((speaker) => (speaker?.styles || [])
                        .map((style) => style?.id?.toString() ?? '')
                        .filter(Boolean))
                    : [];
            }
            const invalidIds = speakerIds.filter((id) => !validIds.includes(id));
            if (invalidIds.length) {
                throw new Error(`Invalid speaker ids: ${invalidIds.join(', ')}`);
            }
        }

        let scriptItems = normalizeScriptItems(podcast.script, {
            defaultInsertVideoPath: DEFAULT_INSERT_VIDEO_PATH
        });

        const hasInsertVideo = scriptItems.some((item) => item && item.insert_video);
        const topLevelMappingPath = (typeof podcast.insertVideoMapping === 'string' && podcast.insertVideoMapping.trim())
            ? podcast.insertVideoMapping.trim()
            : DEFAULT_INSERT_VIDEO_MAPPING_PATH;
        if (hasInsertVideo) {
            const mappingPlan = buildInsertVideoMappingPlan({
                scriptItems,
                topLevelMappingPath,
                defaultInsertVideoMappingPath: DEFAULT_INSERT_VIDEO_MAPPING_PATH,
                skipAlreadyProcessed: true
            });
            const mappingLoadCache = new Map();
            const reportedCandidateErrors = new Set();
            const groupedTargets = new Map();

            const loadMappingCandidate = (candidatePath) => {
                if (mappingLoadCache.has(candidatePath)) {
                    return mappingLoadCache.get(candidatePath);
                }
                const resolvedPath = resolveWorkPath(candidatePath, normalizedWorkDir);
                if (!resolvedPath || !fs.existsSync(resolvedPath)) {
                    const missingResult = {
                        success: false,
                        path: candidatePath,
                        resolvedPath,
                        error: 'file not found'
                    };
                    mappingLoadCache.set(candidatePath, missingResult);
                    return missingResult;
                }
                try {
                    const mappingRaw = fs.readFileSync(resolvedPath, 'utf8');
                    const mappingData = JSON.parse(mappingRaw);
                    const successResult = {
                        success: true,
                        path: candidatePath,
                        resolvedPath,
                        data: mappingData
                    };
                    mappingLoadCache.set(candidatePath, successResult);
                    return successResult;
                } catch (error) {
                    const parseErrorResult = {
                        success: false,
                        path: candidatePath,
                        resolvedPath,
                        error: error.message
                    };
                    mappingLoadCache.set(candidatePath, parseErrorResult);
                    return parseErrorResult;
                }
            };

            mappingPlan.forEach(({ index, item, candidates }) => {
                const candidateList = Array.isArray(candidates) ? candidates : [];
                let chosenPath = null;

                for (let i = 0; i < candidateList.length; i += 1) {
                    const candidate = candidateList[i];
                    const loaded = loadMappingCandidate(candidate);
                    if (loaded.success) {
                        chosenPath = candidate;
                        break;
                    }
                    if (loaded.resolvedPath && loaded.error && loaded.error !== 'file not found') {
                        const errorKey = `${candidate}|${loaded.resolvedPath}|${loaded.error}`;
                        if (!reportedCandidateErrors.has(errorKey)) {
                            reportedCandidateErrors.add(errorKey);
                            log.warn?.(`[InsertVideoAdjust] Mapping load failed: ${loaded.resolvedPath} (${loaded.error})`);
                        }
                    }
                }

                if (!chosenPath) {
                    log.warn?.(
                        `[InsertVideoAdjust] Mapping file not found for insert_video. ` +
                        `start=${item?.startTime || item?.start_time || '-'} end=${item?.endTime || item?.end_time || '-'} ` +
                        `path=${item?.insert_video || item?.videoPath || item?.path || '-'} candidates=${candidateList.join(', ')}`
                    );
                    return;
                }

                if (!groupedTargets.has(chosenPath)) {
                    groupedTargets.set(chosenPath, []);
                }
                groupedTargets.get(chosenPath).push(index);
            });

            groupedTargets.forEach((targetIndexes, mappingPath) => {
                const loaded = mappingLoadCache.get(mappingPath);
                if (!loaded?.success || !loaded.data) return;
                try {
                    const { updatedScriptItems, unmatchedItems } = adjustInsertVideoTimingsCore({
                        scriptItems,
                        mappingData: loaded.data,
                        skipAlreadyProcessed: true,
                        toleranceSeconds: 1,
                        targetIndexes
                    });
                    scriptItems = updatedScriptItems;
                    if (unmatchedItems.length) {
                        log.warn?.(`[InsertVideoAdjust] Unmatched insert_video items: ${unmatchedItems.length} (mapping: ${loaded.resolvedPath || mappingPath})`);
                        unmatchedItems.forEach((item) => {
                            log.warn?.(`[InsertVideoAdjust] Unmatched start=${item.startTime || '-'} end=${item.endTime || '-'} text=${item.text || ''}`);
                        });
                    }
                } catch (error) {
                    log.warn?.(`[InsertVideoAdjust] Failed to apply mapping (${loaded.resolvedPath || mappingPath}). Skipping: ${error.message}`);
                }
            });
        }

        const youtubeInfo = {
            title: podcast.youtube.title ?? '',
            description: buildYoutubeDescription(
                podcast.youtube.description ?? '',
                preset.fixedDescription,
                podcast.youtube.fixedDescription
            ),
            tags: normalizeTags(podcast.youtube.tags),
            categoryId: podcast.youtube.category,
            thumbnailPath: podcast.youtube.thumbnailPath ?? ''
        };

        const bgmPath = effectiveBgmPathOverride
            ? (resolveWorkPath(effectiveBgmPathOverride, normalizedWorkDir) || effectiveBgmPathOverride)
            : resolveBgmPath(effectiveBgmName, normalizedWorkDir);
        if (typeof ttsService.setBgmPath === 'function') {
            ttsService.setBgmPath(bgmPath);
        }
        if (typeof ttsService.setBgmVolume === 'function') {
            ttsService.setBgmVolume(effectiveBgmVolume);
        }
        if (typeof ttsService.setCaptionsEnabled === 'function') {
            ttsService.setCaptionsEnabled(effectiveCaptionsEnabled);
        }
        if (typeof ttsService.setIntroBgVideo === 'function') {
            ttsService.setIntroBgVideo(effectiveIntroBgVideo);
        }
        if (typeof ttsService.setSpeakerVideoPrefix === 'function') {
            ttsService.setSpeakerVideoPrefix(effectiveSpeakerVideoPrefix);
        }

        try {
            const canonicalRequest = buildCanonicalRequest({
                request: {
                    preset: podcast.preset,
                    script: scriptItems,
                    youtube: {
                        title: podcast.youtube.title ?? '',
                        description: podcast.youtube.description ?? '',
                        tags: normalizeTags(podcast.youtube.tags),
                        category: podcast.youtube.category,
                        thumbnailPath: podcast.youtube.thumbnailPath ?? '',
                        fixedDescription: podcast.youtube.fixedDescription ?? ''
                    },
                    insertVideoMapping: topLevelMappingPath,
                    runtimeOverrides: {
                        videoFormat: effectiveVideoFormat,
                        playbackSpeed: effectivePlaybackSpeed,
                        autoUpload: effectiveAutoUpload,
                        youtubeToken: effectiveYoutubeToken,
                        speakerVideoPrefix: effectiveSpeakerVideoPrefix,
                        bgm: effectiveBgmName,
                        bgmPath,
                        bgmVolume: effectiveBgmVolume,
                        captionsEnabled: effectiveCaptionsEnabled,
                        introBgVideo: effectiveIntroBgVideo,
                        backgroundText: runtimeOverrides.backgroundText || youtubeInfo.title,
                        language: effectiveLanguage
                    }
                }
            });
            const createdSave = createSaveRecord({
                source: 'cli',
                request: canonicalRequest,
                workDir: normalizedWorkDir,
                result: { status: 'processing' }
            });
            const writtenSave = writeSaveRecord({
                workDir: normalizedWorkDir,
                record: createdSave.record,
                fileName: createdSave.fileName
            });
            saveRecordRef = {
                id: createdSave.record.id,
                filePath: writtenSave.filePath
            };
            log.info?.(`[save] created: ${writtenSave.filePath}`);
        } catch (error) {
            log.warn?.(`[save] failed to create save record: ${error.message}`);
        }

        const progressHandler = (data) => {
            if (!data || !data.type) return;
            log.info?.(`[progress] ${data.type}: ${formatProgress(data.progress)}`);
        };

        const processingComplete = new Promise((resolve, reject) => {
            const cleanup = () => {
                ttsService.off('processing-complete', onComplete);
                ttsService.off('processing-error', onError);
                ttsService.off('progress', progressHandler);
            };
            const onComplete = (data) => {
                cleanup();
                resolve({ data });
            };
            const onError = (payload) => {
                cleanup();
                const detail = (typeof payload?.error === 'string' && payload.error.trim())
                    ? payload.error.trim()
                    : 'processing failed';
                reject(new Error(detail));
            };
            ttsService.on('processing-complete', onComplete);
            ttsService.on('processing-error', onError);
            ttsService.on('progress', progressHandler);
        });

        const presetLang = effectiveLanguage;
        ttsService.playAudio(
            scriptItems,
            0,
            effectivePlaybackSpeed,
            false,
            { language: presetLang, videoFormat: effectiveVideoFormat }
        );

        await ttsService.pauseAudio();

        if (typeof ttsService.setAutoGenerateVideo === 'function') {
            ttsService.setAutoGenerateVideo(true);
        }
        if (typeof ttsService.setAutoUploadToYoutube === 'function') {
            ttsService.setAutoUploadToYoutube(effectiveAutoUpload);
        }
        if (typeof ttsService.setYoutubeInfo === 'function') {
            ttsService.setYoutubeInfo(youtubeInfo);
        }

        if (typeof ttsService.createBackgroundImage === 'function') {
            const backgroundText = (typeof runtimeOverrides.backgroundText === 'string' && runtimeOverrides.backgroundText.trim())
                ? runtimeOverrides.backgroundText
                : youtubeInfo.title;
            await ttsService.createBackgroundImage(backgroundText);
        }

        const completed = await processingComplete;
        if (saveRecordRef?.id) {
            try {
                updateSaveRecordResult({
                    workDir: normalizedWorkDir,
                    id: saveRecordRef.id,
                    result: {
                        status: 'completed',
                        outputPath: completed?.data?.outputPath || '',
                        completedAt: new Date().toISOString()
                    }
                });
            } catch (error) {
                log.warn?.(`[save] failed to update completed result: ${error.message}`);
            }
        }
        return 0;
    } catch (error) {
        if (saveRecordRef?.id && normalizedWorkDir) {
            try {
                updateSaveRecordResult({
                    workDir: normalizedWorkDir,
                    id: saveRecordRef.id,
                    result: {
                        status: 'error',
                        error: error?.message || String(error),
                        failedAt: new Date().toISOString()
                    }
                });
            } catch (saveError) {
                log.warn?.(`[save] failed to update error result: ${saveError.message}`);
            }
        }
        log.error?.(error?.message || String(error));
        return 1;
    }
};

module.exports = {
    runPodcastRunner,
    parseCliArgs
};

if (require.main === module) {
    const args = parseCliArgs(process.argv.slice(2));
    const workDir = args.workDir || process.env.PODCAST_CREATOR_WORKDIR;
    const podcastPath = args.podcastPath;
    const resumePath = args.resumePath;
    const ttsService = require('../tts-service');

    runPodcastRunner({ podcastPath, resumePath, workDir, ttsService })
        .then((code) => {
            process.exit(code);
        })
        .catch((error) => {
            console.error(error?.message || error);
            process.exit(1);
        });
}
