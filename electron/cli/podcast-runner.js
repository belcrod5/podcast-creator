const fs = require('fs');
const path = require('path');
const {
    normalizeScriptItems,
    adjustInsertVideoTimingsCore
} = require('../../shared/podcast-script');

const PRESET_CONFIG_PATH = 'assets/data/podcastcreator-preset.json';
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
        workDir: readValue('--workdir')
    };
};

const resolveWorkPath = (targetPath, workDir) => {
    if (!targetPath || !workDir) return null;
    const normalizedTarget = (typeof targetPath === 'string') ? targetPath : String(targetPath);
    const trimmed = normalizedTarget.trim();
    if (!trimmed) return null;

    let resolved = path.isAbsolute(trimmed) ? trimmed : path.join(workDir, trimmed);
    if (!path.isAbsolute(trimmed) && !fs.existsSync(resolved)) {
        const stripped = trimmed.replace(/^assets[\\/]+/, '');
        if (stripped !== trimmed) {
            const alt = path.join(workDir, stripped);
            if (fs.existsSync(alt)) {
                resolved = alt;
            }
        }
    }
    return resolved;
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
    const nested = path.join(workDir, 'assets');
    try {
        if (fs.existsSync(nested) && fs.statSync(nested).isDirectory()) {
            return nested;
        }
    } catch (_) {
        /* ignore */
    }
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

const runPodcastRunner = async ({
    podcastPath,
    workDir,
    ttsService,
    log = console
} = {}) => {
    try {
        const normalizedWorkDir = (typeof workDir === 'string' && workDir.trim()) ? workDir.trim() : null;
        if (!normalizedWorkDir) {
            throw new Error('Missing workdir. Set PODCAST_CREATOR_WORKDIR or pass --workdir.');
        }
        const normalizedPodcastPath = (typeof podcastPath === 'string' && podcastPath.trim()) ? podcastPath.trim() : '';
        if (!normalizedPodcastPath) {
            throw new Error('Missing podcast JSON. Pass --podcast /path/to/podcast.json');
        }
        if (!ttsService) {
            throw new Error('ttsService is not available');
        }

        process.env.PODCAST_CREATOR_WORKDIR = normalizedWorkDir;
        if (typeof ttsService.setWorkDir === 'function') {
            ttsService.setWorkDir(normalizedWorkDir);
        }

        const podcastResult = readJsonFile(normalizedPodcastPath, normalizedWorkDir, 'podcast.json');
        const podcast = podcastResult.data;
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

        const speakerIds = collectSpeakerIds(podcast.script);
        if (speakerIds.length) {
            const lang = normalizeLanguage(preset.lang);
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
        if (hasInsertVideo) {
            const mappingPath = (typeof podcast.insertVideoMapping === 'string' && podcast.insertVideoMapping.trim())
                ? podcast.insertVideoMapping.trim()
                : DEFAULT_INSERT_VIDEO_MAPPING_PATH;
            const resolvedMappingPath = resolveWorkPath(mappingPath, normalizedWorkDir);
            if (!resolvedMappingPath || !fs.existsSync(resolvedMappingPath)) {
                log.warn?.(`[InsertVideoAdjust] Mapping file not found. Skipping: ${resolvedMappingPath || mappingPath}`);
            } else {
                try {
                    const mappingRaw = fs.readFileSync(resolvedMappingPath, 'utf8');
                    const mappingData = JSON.parse(mappingRaw);
                    const { updatedScriptItems, unmatchedItems } = adjustInsertVideoTimingsCore({
                        scriptItems,
                        mappingData,
                        skipAlreadyProcessed: true,
                        toleranceSeconds: 1
                    });
                    scriptItems = updatedScriptItems;
                    if (unmatchedItems.length) {
                        log.warn?.(`[InsertVideoAdjust] Unmatched insert_video items: ${unmatchedItems.length}`);
                        unmatchedItems.forEach((item) => {
                            log.warn?.(`[InsertVideoAdjust] Unmatched start=${item.startTime || '-'} end=${item.endTime || '-'} text=${item.text || ''}`);
                        });
                    }
                } catch (error) {
                    log.warn?.(`[InsertVideoAdjust] Failed to apply mapping. Skipping: ${error.message}`);
                }
            }
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

        const bgmPath = resolveBgmPath(preset.bgm, normalizedWorkDir);
        if (typeof ttsService.setBgmPath === 'function') {
            ttsService.setBgmPath(bgmPath);
        }
        if (typeof ttsService.setBgmVolume === 'function') {
            ttsService.setBgmVolume(preset.bgmVolume);
        }
        if (typeof ttsService.setCaptionsEnabled === 'function') {
            ttsService.setCaptionsEnabled(preset.captionsEnabled);
        }
        if (typeof ttsService.setIntroBgVideo === 'function') {
            ttsService.setIntroBgVideo(preset.introBgVideo);
        }
        if (typeof ttsService.setSpeakerVideoPrefix === 'function') {
            ttsService.setSpeakerVideoPrefix(preset.speakerVideoPrefix);
        }

        const progressHandler = (data) => {
            if (!data || !data.type) return;
            log.info?.(`[progress] ${data.type}: ${formatProgress(data.progress)}`);
        };

        const processingComplete = new Promise((resolve) => {
            const onComplete = (data) => {
                ttsService.off('processing-complete', onComplete);
                ttsService.off('progress', progressHandler);
                resolve({ data });
            };
            ttsService.on('processing-complete', onComplete);
        });

        ttsService.on('progress', progressHandler);

        const presetLang = normalizeLanguage(preset.lang);
        ttsService.playAudio(
            scriptItems,
            0,
            preset.playbackSpeed,
            false,
            { language: presetLang, videoFormat: preset.videoFormat }
        );

        await ttsService.pauseAudio();

        if (typeof ttsService.setAutoGenerateVideo === 'function') {
            ttsService.setAutoGenerateVideo(true);
        }
        if (typeof ttsService.setAutoUploadToYoutube === 'function') {
            ttsService.setAutoUploadToYoutube(preset.autoUpload);
        }
        if (typeof ttsService.setYoutubeTokenFile === 'function' && typeof preset.youtubeToken === 'string' && preset.youtubeToken.trim()) {
            ttsService.setYoutubeTokenFile(preset.youtubeToken.trim());
        }
        if (typeof ttsService.setYoutubeInfo === 'function') {
            ttsService.setYoutubeInfo(youtubeInfo);
        }

        if (typeof ttsService.createBackgroundImage === 'function') {
            await ttsService.createBackgroundImage(youtubeInfo.title);
        }

        await processingComplete;
        return 0;
    } catch (error) {
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
    const ttsService = require('../tts-service');

    runPodcastRunner({ podcastPath, workDir, ttsService })
        .then((code) => {
            process.exit(code);
        })
        .catch((error) => {
            console.error(error?.message || error);
            process.exit(1);
        });
}
