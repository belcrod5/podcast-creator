const DEFAULT_INSERT_VIDEO_PATH = 'videos/output.mp4';
const DEFAULT_INSERT_VIDEO_MAPPING_PATH = `${DEFAULT_INSERT_VIDEO_PATH}.json`;

const parseTimeInput = (value) => {
    if (!value) return 0;

    if (typeof value === 'number' && Number.isFinite(value)) {
        return Math.max(0, Math.floor(value));
    }

    const parts = String(value)
        .split(':')
        .map((part) => part.trim())
        .filter(Boolean)
        .map(Number)
        .filter(Number.isFinite);

    if (!parts.length) return 0;

    let seconds = 0;
    let multiplier = 1;
    for (let i = parts.length - 1; i >= 0; i -= 1) {
        seconds += parts[i] * multiplier;
        multiplier *= 60;
    }

    return Math.max(0, Math.floor(seconds));
};

const formatTimeInput = (value) => {
    const totalSeconds = Math.max(0, Math.floor(Number(value) || 0));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    const parts = [
        String(hours).padStart(2, '0'),
        String(minutes).padStart(2, '0'),
        String(seconds).padStart(2, '0')
    ];

    return parts.join(':');
};

const sanitizeTimeValue = (value) => formatTimeInput(parseTimeInput(value));

const normalizeVideoTimes = (startValue, endValue) => {
    const startSeconds = parseTimeInput(startValue);
    let endSeconds = parseTimeInput(endValue);

    if (endSeconds <= startSeconds) {
        endSeconds = startSeconds + 1;
    }

    return {
        startTime: formatTimeInput(startSeconds),
        endTime: formatTimeInput(endSeconds)
    };
};

const parseTimeToSeconds = (value) => {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }

    const stringValue = String(value).trim();
    if (!stringValue) return null;

    if (/^\d+(?:\.\d+)?$/.test(stringValue)) {
        const num = Number(stringValue);
        return Number.isFinite(num) ? num : null;
    }

    const parts = stringValue
        .split(':')
        .map((part) => Number(part.trim()))
        .filter((part) => Number.isFinite(part));

    if (!parts.length) return null;

    let seconds = 0;
    let multiplier = 1;
    for (let i = parts.length - 1; i >= 0; i -= 1) {
        seconds += parts[i] * multiplier;
        multiplier *= 60;
    }

    return Number.isFinite(seconds) ? seconds : null;
};

const formatSecondsWithMilliseconds = (totalSeconds) => {
    if (!Number.isFinite(totalSeconds)) return null;
    const normalized = Math.max(0, totalSeconds);
    const integerPart = Math.floor(normalized);
    const fractional = Math.round((normalized - integerPart) * 1000);
    const base = formatTimeInput(integerPart);
    if (fractional > 0) {
        return `${base}.${String(fractional).padStart(3, '0')}`;
    }
    return base;
};

const normalizeTimeKey = (value) => {
    const seconds = parseTimeToSeconds(value);
    if (!Number.isFinite(seconds)) return null;
    return formatSecondsWithMilliseconds(seconds);
};

const normalizeNonEmptyString = (value) => (
    typeof value === 'string' && value.trim() ? value.trim() : ''
);

const hasSchemePrefix = (value) => /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value);

const isWindowsAbsolutePath = (value) => /^[a-zA-Z]:[\\/]/.test(value);

const buildInsertVideoMappingCandidates = ({
    item,
    topLevelMappingPath = '',
    defaultInsertVideoMappingPath = DEFAULT_INSERT_VIDEO_MAPPING_PATH
} = {}) => {
    const target = (item && typeof item === 'object') ? item : {};
    const candidates = [];
    const pushCandidate = (candidate) => {
        const normalized = normalizeNonEmptyString(candidate);
        if (!normalized || candidates.includes(normalized)) return;
        candidates.push(normalized);
    };

    const itemLevelMappingPath = normalizeNonEmptyString(
        target.insertVideoMapping || target.insert_video_mapping
    );
    if (itemLevelMappingPath) {
        pushCandidate(itemLevelMappingPath);
    }

    const insertVideoPath = normalizeNonEmptyString(target.insert_video || target.videoPath || target.path);
    if (insertVideoPath) {
        const canDeriveFromInsertVideo = (
            isWindowsAbsolutePath(insertVideoPath)
            || insertVideoPath.startsWith('/')
            || !hasSchemePrefix(insertVideoPath)
        );
        if (canDeriveFromInsertVideo) {
            pushCandidate(`${insertVideoPath}.json`);
        }
    }

    pushCandidate(topLevelMappingPath);
    pushCandidate(defaultInsertVideoMappingPath);
    return candidates;
};

const buildInsertVideoMappingPlan = ({
    scriptItems = [],
    topLevelMappingPath = '',
    defaultInsertVideoMappingPath = DEFAULT_INSERT_VIDEO_MAPPING_PATH,
    skipAlreadyProcessed = false
} = {}) => (
    (Array.isArray(scriptItems) ? scriptItems : [])
        .map((item, index) => ({ item, index }))
        .filter(({ item }) => item && item.insert_video && (!skipAlreadyProcessed || !item.insert_video_done))
        .map(({ item, index }) => ({
            index,
            item,
            candidates: buildInsertVideoMappingCandidates({
                item,
                topLevelMappingPath,
                defaultInsertVideoMappingPath
            })
        }))
);

const normalizeScriptItems = (items = [], options = {}) => {
    const defaultInsertVideoPath = (options && typeof options.defaultInsertVideoPath === 'string' && options.defaultInsertVideoPath.trim())
        ? options.defaultInsertVideoPath
        : DEFAULT_INSERT_VIDEO_PATH;

    return items.map((original = {}) => {
        if (!original || typeof original !== 'object') {
            return original;
        }

        if (original.section) {
            return {
                ...original,
                isSection: true
            };
        }

        const item = { ...original };
        const isBooleanInsertVideo = item.insert_video === true;
        const hasInsertVideoPath = typeof item.insert_video === 'string' && item.insert_video;
        const fallbackPath = typeof item.path === 'string' && item.path
            ? item.path
            : (typeof item.videoPath === 'string' ? item.videoPath : '');
        const resolvedInsertVideo = isBooleanInsertVideo
            ? defaultInsertVideoPath
            : (hasInsertVideoPath ? item.insert_video : fallbackPath);

        if (isBooleanInsertVideo) {
            item.insert_video_done = false;
        }

        if (resolvedInsertVideo) {
            const normalizedStart = sanitizeTimeValue(item.startTime || item.start_time || '00:00:00');
            let normalizedEnd = sanitizeTimeValue(item.endTime || item.end_time || normalizedStart);

            const startSeconds = parseTimeInput(normalizedStart);
            let endSeconds = parseTimeInput(normalizedEnd);
            if (endSeconds <= startSeconds) {
                endSeconds = startSeconds + 1;
                normalizedEnd = formatTimeInput(endSeconds);
            }

            const isRemotePath = typeof resolvedInsertVideo === 'string' && resolvedInsertVideo.startsWith('http');

            const updatedItem = {
                ...item,
                insert_video: resolvedInsertVideo,
                path: resolvedInsertVideo,
                videoPath: resolvedInsertVideo,
                startTime: formatTimeInput(startSeconds),
                endTime: formatTimeInput(endSeconds),
                videoStartOffset: startSeconds,
                videoEndOffset: endSeconds,
                duration: Math.max(1, endSeconds - startSeconds)
            };

            if (!isRemotePath && resolvedInsertVideo) {
                updatedItem.localPath = resolvedInsertVideo;
            }

            return updatedItem;
        }

        return item;
    });
};

const adjustInsertVideoTimingsCore = ({
    scriptItems = [],
    mappingData,
    skipAlreadyProcessed = false,
    toleranceSeconds = 1,
    targetIndexes = null
} = {}) => {
    if (!mappingData || !Array.isArray(mappingData.script)) {
        throw new Error('マッピングデータにscript配列が存在しません');
    }

    const mappingEntries = mappingData.script;
    if (!mappingEntries.length) {
        throw new Error('マッピングデータのscript配列が空です');
    }

    const targetIndexSet = Array.isArray(targetIndexes) && targetIndexes.length
        ? new Set(targetIndexes.filter((value) => Number.isInteger(value) && value >= 0))
        : null;

    const scriptItemsWithVideo = scriptItems
        .map((item, index) => ({ item, index }))
        .filter(({ item, index }) => {
            if (!item || !item.insert_video) return false;
            if (skipAlreadyProcessed && item.insert_video_done) return false;
            if (targetIndexSet && !targetIndexSet.has(index)) return false;
            return true;
        });
    if (!scriptItemsWithVideo.length) {
        throw new Error('挿入動画が設定されたスクリプトがありません');
    }

    console.log('[InsertVideoAdjust] mappingEntries count', mappingEntries.length);
    console.log('[InsertVideoAdjust] insertVideo script item count', scriptItemsWithVideo.length);

    const getEntryValue = (entry, keys) => {
        for (let i = 0; i < keys.length; i += 1) {
            const value = entry?.[keys[i]];
            if (value !== undefined && value !== null) {
                return value;
            }
        }
        return null;
    };

    const addLookupEntry = (lookup, rawKey, entry, source) => {
        const key = normalizeTimeKey(rawKey);
        if (!key) return;
        if (!lookup.has(key)) {
            lookup.set(key, []);
        }
        lookup.get(key).push({ entry, source });
    };

    const startLookup = new Map();
    const endLookup = new Map();

    mappingEntries.forEach((entry, index) => {
        const rawStart = getEntryValue(entry, ['startTime', 'start_time', 'startSeconds', 'start_seconds']);
        const rawEnd = getEntryValue(entry, ['endTime', 'end_time', 'endSeconds', 'end_seconds']);
        const rawSegmentStart = getEntryValue(entry, ['segmentStartTime', 'segment_start_time', 'segmentStartSeconds', 'segment_start_seconds']);
        const rawSegmentEnd = getEntryValue(entry, ['segmentEndTime', 'segment_end_time', 'segmentEndSeconds', 'segment_end_seconds']);

        if (index < 5 || (typeof rawStart === 'string' && rawStart.includes('00:02:38'))) {
            console.log('[InsertVideoAdjust] mapping entry sample', index, {
                rawStart,
                rawEnd,
                rawSegmentStart,
                rawSegmentEnd,
                normalizedStart: normalizeTimeKey(rawStart),
                normalizedEnd: normalizeTimeKey(rawEnd),
                normalizedSegmentStart: normalizeTimeKey(rawSegmentStart),
                normalizedSegmentEnd: normalizeTimeKey(rawSegmentEnd),
                changedStart: getEntryValue(entry, ['changedStartTime', 'changed_start_time', 'changedStartSeconds', 'changed_start_seconds']),
                changedEnd: getEntryValue(entry, ['changedEndTime', 'changed_end_time', 'changedEndSeconds', 'changed_end_seconds']),
                changedSegmentStart: getEntryValue(entry, ['changedSegmentStartTime', 'changed_segment_start_time', 'changedSegmentStartSeconds', 'changed_segment_start_seconds']),
                changedSegmentEnd: getEntryValue(entry, ['changedSegmentEndTime', 'changed_segment_end_time', 'changedSegmentEndSeconds', 'changed_segment_end_seconds'])
            });
        }

        addLookupEntry(startLookup, rawStart, entry, 'startTime');
        addLookupEntry(startLookup, rawSegmentStart, entry, 'segmentStart');
        addLookupEntry(endLookup, rawEnd, entry, 'endTime');
        addLookupEntry(endLookup, rawSegmentEnd, entry, 'segmentEnd');
    });

    console.log('[InsertVideoAdjust] startLookup keys', startLookup.size);
    console.log('[InsertVideoAdjust] endLookup keys', endLookup.size);

    const matchedEntries = new Set();
    const unmatchedItems = [];
    const updatedScriptItems = scriptItems.map((item) => ({ ...item }));
    const matchTolerance = Number.isFinite(toleranceSeconds) ? toleranceSeconds : 1;

    const pickMatch = (lookup, key) => {
        if (!key) return null;
        const candidates = lookup.get(key) || [];
        for (let i = 0; i < candidates.length; i += 1) {
            const candidate = candidates[i];
            if (!matchedEntries.has(candidate.entry)) {
                return candidate;
            }
        }
        return null;
    };

    const findClosestMatch = (isStart, targetSeconds) => {
        if (!Number.isFinite(targetSeconds)) return null;
        let bestCandidate = null;
        let bestDiff = Infinity;

        mappingEntries.forEach((entry) => {
            if (matchedEntries.has(entry)) return;
            const startCandidates = [
                { value: getEntryValue(entry, ['startTime', 'start_time', 'startSeconds', 'start_seconds']), source: 'startTime' },
                { value: getEntryValue(entry, ['segmentStartTime', 'segment_start_time', 'segmentStartSeconds', 'segment_start_seconds']), source: 'segmentStart' }
            ];
            const endCandidates = [
                { value: getEntryValue(entry, ['endTime', 'end_time', 'endSeconds', 'end_seconds']), source: 'endTime' },
                { value: getEntryValue(entry, ['segmentEndTime', 'segment_end_time', 'segmentEndSeconds', 'segment_end_seconds']), source: 'segmentEnd' }
            ];

            const candidates = isStart ? startCandidates : [...endCandidates, ...startCandidates];

            candidates.forEach(({ value, source }) => {
                const seconds = parseTimeToSeconds(value);
                if (!Number.isFinite(seconds)) return;
                const diff = Math.abs(seconds - targetSeconds);
                if (diff < bestDiff) {
                    bestDiff = diff;
                    bestCandidate = { entry, source, diff };
                }
            });
        });

        if (bestCandidate && bestDiff > matchTolerance) {
            console.log('[InsertVideoAdjust] closest match outside tolerance', {
                targetSeconds,
                source: isStart ? 'start' : 'end',
                diff: bestDiff,
                candidateSource: bestCandidate.source
            });
        }

        return bestCandidate;
    };

    const getChangedTime = (entry, source, isStart) => {
        if (!entry) return null;
        const primaryKeys = isStart
            ? ['changedStartTime', 'changed_start_time', 'changedStartSeconds', 'changed_start_seconds']
            : ['changedEndTime', 'changed_end_time', 'changedEndSeconds', 'changed_end_seconds'];
        const segmentKeys = isStart
            ? ['changedSegmentStartTime', 'changed_segment_start_time', 'changedSegmentStartSeconds', 'changed_segment_start_seconds']
            : ['changedSegmentEndTime', 'changed_segment_end_time', 'changedSegmentEndSeconds', 'changed_segment_end_seconds'];
        const fallbackKeys = isStart
            ? ['startTime', 'start_time', 'startSeconds', 'start_seconds', 'segmentStartTime', 'segment_start_time', 'segmentStartSeconds', 'segment_start_seconds']
            : ['endTime', 'end_time', 'endSeconds', 'end_seconds', 'segmentEndTime', 'segment_end_time', 'segmentEndSeconds', 'segment_end_seconds'];

        const orderedKeys = (source && source.includes('segment'))
            ? [...segmentKeys, ...primaryKeys, ...fallbackKeys]
            : [...primaryKeys, ...segmentKeys, ...fallbackKeys];

        const raw = getEntryValue(entry, orderedKeys);
        return normalizeTimeKey(raw);
    };

    const resolveEndTime = (startMatch, endMatch) => {
        const preferStartSources = ['startTime', 'segmentStart'];
        const preferEndSources = ['endTime', 'segmentEnd'];

        if (endMatch) {
            const useStartSide = preferStartSources.includes(endMatch.source);
            const primary = getChangedTime(endMatch.entry, endMatch.source, useStartSide);
            if (primary) return primary;

            const secondary = getChangedTime(endMatch.entry, endMatch.source, !useStartSide);
            if (secondary) return secondary;
        }

        if (startMatch) {
            const fromStartEntry = getChangedTime(startMatch.entry, startMatch.source, false);
            if (fromStartEntry) return fromStartEntry;

            const fallback = getChangedTime(startMatch.entry, startMatch.source, true);
            if (fallback) return fallback;
        }

        if (endMatch) {
            const finalFallback = getChangedTime(endMatch.entry, endMatch.source, true);
            if (finalFallback) return finalFallback;
        }

        return null;
    };

    scriptItemsWithVideo.forEach(({ item, index }) => {
        const originalStart = item.startTime || item.start_time;
        const originalEnd = item.endTime || item.end_time;
        const normalizedStart = normalizeTimeKey(originalStart);
        const normalizedEnd = normalizeTimeKey(originalEnd);
        const startSeconds = parseTimeToSeconds(originalStart);
        const endSeconds = parseTimeToSeconds(originalEnd);

        let startMatch = pickMatch(startLookup, normalizedStart);
        if (!startMatch) {
            startMatch = findClosestMatch(true, startSeconds);
        }

        let endMatch = pickMatch(endLookup, normalizedEnd);
        if (!endMatch) {
            endMatch = findClosestMatch(false, endSeconds);
        }

        const newStart = startMatch ? getChangedTime(startMatch.entry, startMatch.source, true) : null;
        const newEnd = resolveEndTime(startMatch, endMatch);

        if (!newStart || !newEnd) {
            console.log('[InsertVideoAdjust] no match for insert_video', {
                startTime: originalStart,
                endTime: originalEnd,
                text: item.text,
                startMatchSource: startMatch?.source,
                endMatchSource: endMatch?.source,
                startFound: !!newStart,
                endFound: !!newEnd
            });
            unmatchedItems.push({
                startTime: originalStart,
                endTime: originalEnd,
                text: item.text || ''
            });
            return;
        }

        const { startTime, endTime } = normalizeVideoTimes(newStart, newEnd);
        const updatedStartSeconds = parseTimeInput(startTime);
        const updatedEndSeconds = parseTimeInput(endTime);

        console.log('[InsertVideoAdjust] applying new times', {
            originalStart,
            originalEnd,
            newStart,
            newEnd,
            startSource: startMatch?.source,
            endSource: endMatch?.source
        });

        const usedEntries = new Set();
        if (startMatch?.entry) usedEntries.add(startMatch.entry);
        if (endMatch?.entry) usedEntries.add(endMatch.entry);
        usedEntries.forEach((entry) => matchedEntries.add(entry));

        updatedScriptItems[index] = {
            ...updatedScriptItems[index],
            startTime,
            endTime,
            videoStartOffset: updatedStartSeconds,
            videoEndOffset: updatedEndSeconds,
            duration: Math.max(1, updatedEndSeconds - updatedStartSeconds),
            insert_video_done: true
        };
    });

    return {
        updatedScriptItems,
        unmatchedItems
    };
};

module.exports = {
    DEFAULT_INSERT_VIDEO_MAPPING_PATH,
    parseTimeInput,
    formatTimeInput,
    sanitizeTimeValue,
    normalizeVideoTimes,
    parseTimeToSeconds,
    formatSecondsWithMilliseconds,
    normalizeTimeKey,
    buildInsertVideoMappingCandidates,
    buildInsertVideoMappingPlan,
    normalizeScriptItems,
    adjustInsertVideoTimingsCore
};
