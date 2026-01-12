'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');

const projectRoot = path.join(__dirname, '..');
const assetsPath = path.join(projectRoot, 'assets');
const backgroundsDir = path.join(assetsPath, 'backgrounds');
const speakerVideosDir = path.join(assetsPath, 'speaker-videos');

const ttsService = require('../electron/tts-service');
const testData = require('./tts-service-test-data.json');

const defaultBgmPath = path.join(backgroundsDir, 'default-bgm.mp3');

if (!fs.existsSync(defaultBgmPath)) {
    throw new Error(`Missing default BGM file at ${defaultBgmPath}`);
}

function ensureFileExists(label, filePath) {
    if (!fs.existsSync(filePath)) {
        throw new Error(`${label} が存在しません: ${filePath}\nテストデータ (tests/tts-service-test-data.json) を確認してください。`);
    }
}

const tests = [];

function test(name, fn) {
    tests.push({ name, fn });
}

function formatDuration(ms) {
    return `${ms.toFixed(2)}ms`;
}

async function waitFor(conditionFn, { timeoutMs = 600000, intervalMs = 500 } = {}) {
    const start = Date.now();
    while (true) {
        try {
            if (await conditionFn()) {
                return true;
            }
        } catch (_) {
            // Ignore errors during polling and retry until timeout
        }
        if (Date.now() - start >= timeoutMs) {
            return false;
        }
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
}

// Verify that the sample scripts fixture is in the expected shape.
test('test fixture scripts contain four entries with text', () => {
    assert.ok(Array.isArray(testData.scripts), 'testData.scripts should be an array');

    const textEntries = testData.scripts.filter((script) => script && typeof script.text === 'string' && script.text.length > 0);
    assert.strictEqual(textEntries.length, 4, 'scripts with text should contain exactly four entries');

    textEntries.forEach((script, index) => {
        assert.ok(script && typeof script === 'object', `text script #${index + 1} should be an object`);
        assert.ok(script.id, `text script #${index + 1} should have an id`);
        assert.ok(script.text && typeof script.text === 'string', `text script #${index + 1} should include text`);
    });

    const insertVideoEntries = testData.scripts.filter((script) => script && script.insert_video);
    insertVideoEntries.forEach((entry, index) => {
        assert.ok(typeof entry.insert_video === 'string' && entry.insert_video.length > 0, `insert_video entry #${index + 1} requires a video path`);
        assert.ok(entry.startTime, 'insert_video entry requires startTime');
        assert.ok(entry.endTime, 'insert_video entry requires endTime');
    });
});

test('setBgmPath returns provided valid path and updates currentBgmPath', () => {
    const bgmPath = path.join(backgroundsDir, testData.bgmFileName);
    ensureFileExists('テスト用BGMファイル', bgmPath);

    const returnedPath = ttsService.setBgmPath(bgmPath);

    assert.strictEqual(returnedPath, bgmPath, 'setBgmPath should return the valid path that was provided');
    assert.strictEqual(ttsService.currentBgmPath, bgmPath, 'currentBgmPath should be updated to the provided path');
});

test('setBgmPath falls back to default when path is invalid', () => {
    const invalidPath = path.join(backgroundsDir, 'missing-sample.mp3');

    const returnedPath = ttsService.setBgmPath(invalidPath);

    assert.strictEqual(returnedPath, defaultBgmPath, 'Invalid BGM path should fall back to the default BGM');
    assert.strictEqual(ttsService.currentBgmPath, defaultBgmPath, 'currentBgmPath should fall back to default for invalid input');
});

test('getAvailableBgms lists known BGM files', () => {
    const bgms = ttsService.getAvailableBgms();

    assert.ok(Array.isArray(bgms), 'getAvailableBgms should return an array');
    assert.ok(bgms.length > 0, 'getAvailableBgms should not be empty');

    const fileNames = bgms.map((entry) => entry.fileName);
    assert.ok(fileNames.includes(testData.bgmFileName), `${testData.bgmFileName} should be returned by getAvailableBgms`);
});

test('getSpeakerVideoPath resolves existing mood-specific video', () => {
    const { id, mood } = testData.speaker;
    const expectedPath = path.join(speakerVideosDir, `${id}_${mood}.mp4`);
    ensureFileExists('スピーカームード動画', expectedPath);

    ttsService.setSpeakerVideoPrefix('');
    const result = ttsService.getSpeakerVideoPath(id, mood);

    assert.strictEqual(result, expectedPath, 'Mood specific speaker video path should be returned when it exists');
});

test('getSpeakerVideoPath resolves base speaker video when mood is omitted', () => {
    const { id } = testData.speaker;
    const expectedPath = path.join(speakerVideosDir, `${id}.mp4`);
    ensureFileExists('スピーカー通常動画', expectedPath);

    ttsService.setSpeakerVideoPrefix('');
    const result = ttsService.getSpeakerVideoPath(id);

    assert.strictEqual(result, expectedPath, 'Base speaker video path should be returned when mood is not provided');
});

test('getSpeakerVideoPath returns null when prefixed mood video is missing', () => {
    const { id, mood } = testData.speaker;

    ttsService.setSpeakerVideoPrefix(testData.speakerVideoPrefixForNegativeCase);
    const result = ttsService.getSpeakerVideoPath(id, mood);

    assert.strictEqual(result, null, 'Missing prefixed speaker video should result in null');

    // Reset prefix for subsequent tests/manual usage
    ttsService.setSpeakerVideoPrefix('');
});

test('playAudio → generateAudio → makeVideo produces an mp4 file', async () => {
    const scripts = testData.scripts.map((item, index) => ({
        text: item.text,
        id: item.id,
        mood: item.mood,
        time: index * 3,
        insert_video: item.insert_video,
        startTime: item.startTime,
        endTime: item.endTime
    }));

    const filteredScripts = scripts.filter((entry) => {
        if (entry.insert_video) {
            return true;
        }
        return Boolean(entry.text);
    });

    const bgmPath = path.join(backgroundsDir, testData.bgmFileName);
    ensureFileExists('テスト用BGMファイル', bgmPath);
    ttsService.setBgmPath(bgmPath);

    const youtubeTitle = `テスト動画_${Date.now()}`;
    ttsService.setYoutubeInfo({
        title: youtubeTitle,
        description: '自動テストで生成された動画',
        tags: ['auto-test'],
        categoryId: '22'
    });

    await ttsService.stopAudio();

    ttsService.playAudio(filteredScripts, 0, 1.0, false);

    const audioReady = await waitFor(() => {
        const instance = ttsService.currentInstance;
        return !!instance &&
            Array.isArray(instance.audioFiles) &&
            instance.audioFiles.length > 0 &&
            instance.audioFiles.every((file) => file.created && file.path && fs.existsSync(file.path));
    }, { timeoutMs: 10 * 60 * 1000, intervalMs: 1000 });

    assert.ok(audioReady, '音声生成が完了しませんでした');

    const videoResult = await ttsService.makeVideo();

    assert.ok(videoResult, 'makeVideo should set an output path');
    assert.ok(fs.existsSync(videoResult), `生成された動画ファイルが存在しません: ${videoResult}`);
    const stats = fs.statSync(videoResult);
    assert.ok(stats.size > 0, '動画ファイルのサイズが0ではいけません');

    await ttsService.stopAudio();
});

(async () => {
    let failed = false;
    for (const { name, fn } of tests) {
        const start = performance.now();
        try {
            await Promise.resolve(fn());
            const duration = performance.now() - start;
            console.log(`✅ ${name} (${formatDuration(duration)})`);
        } catch (error) {
            const duration = performance.now() - start;
            failed = true;
            console.error(`❌ ${name} (${formatDuration(duration)})`);
            console.error(error.stack || error.message || error);
        }
    }

    if (failed) {
        process.exitCode = 1;
    } else {
        console.log('\nAll tts-service tests passed.');
    }
})();
