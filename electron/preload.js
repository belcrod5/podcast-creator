const { contextBridge, ipcRenderer, clipboard, nativeImage } = require('electron');

contextBridge.exposeInMainWorld('electron', {
    openExternal: (url) => ipcRenderer.invoke('open-external', url),
    podcastSaves: {
        create: (payload) => ipcRenderer.invoke('podcast-save-create', payload),
        list: (payload) => ipcRenderer.invoke('podcast-save-list', payload),
        read: (payload) => ipcRenderer.invoke('podcast-save-read', payload),
        updateResult: (payload) => ipcRenderer.invoke('podcast-save-update-result', payload)
    },
    settings: {
        getWorkDir: () => ipcRenderer.invoke('app-get-work-dir'),
        selectWorkDir: () => ipcRenderer.invoke('app-select-work-dir'),
        openWorkDir: () => ipcRenderer.invoke('app-open-work-dir')
    },
    paths: {
        toFileURL: (absolutePath) => {
            try {
                if (!absolutePath) return '';
                const { pathToFileURL } = require('url');
                return pathToFileURL(absolutePath).href;
            } catch (error) {
                console.error('Failed to convert to file URL:', error);
                return '';
            }
        }
    },
    // TTS関連の機能を追加
    tts: {
        getSpeakers: () => ipcRenderer.invoke('tts-get-speakers'),
        getEnglishSpeakers: () => ipcRenderer.invoke('tts-get-english-speakers'),
        playAudio: (datas, overlapDuration, playbackSpeed, autoGenerateVideo, options) =>
            ipcRenderer.invoke('tts-play-audio', datas, overlapDuration, playbackSpeed, autoGenerateVideo, options),
        stopAudio: () => ipcRenderer.invoke('tts-stop-audio'),
        onPlayed: (callback) => {
            const removeListener = (event, data) => callback(event, data);
            ipcRenderer.on('tts-audio-played', removeListener);
            return () => ipcRenderer.removeListener('tts-audio-played', removeListener);

        },
        pauseAudio: () => ipcRenderer.invoke('tts-pause-audio'),
        resumeAudio: () => ipcRenderer.invoke('tts-resume-audio'),
        nextAudio: () => ipcRenderer.invoke('tts-next-audio'),
        prevAudio: () => ipcRenderer.invoke('tts-prev-audio'),
        restartAudio: () => ipcRenderer.invoke('tts-restart-audio'),
        changeSpeed: (newSpeed) => ipcRenderer.invoke('tts-change-speed', newSpeed),
        makeVideo: () => ipcRenderer.invoke('tts-make-video'),
        onProgress: (callback) => {
            const removeListener = (event, data) => callback(event, data);
            ipcRenderer.on('tts-progress', removeListener);
            return () => ipcRenderer.removeListener('tts-progress', removeListener);
        },
        onProcessingComplete: (callback) => {
            const removeListener = (event, data) => callback(event, data);
            ipcRenderer.on('tts-processing-complete', removeListener);
            return () => ipcRenderer.removeListener('tts-processing-complete', removeListener);
        },
        setAutoGenerateVideo: (value) => ipcRenderer.invoke('tts-set-auto-generate-video', value),
        setYoutubeInfo: (youtubeInfo) => ipcRenderer.invoke('tts-set-youtube-info', youtubeInfo),
        // クリップボードから画像を保存
        saveClipboardImage: () => ipcRenderer.invoke('tts-save-clipboard-image'),
        saveBackgroundImage: (imageBlob) => ipcRenderer.invoke('tts-save-background-image', imageBlob),
        createBackgroundImage: (text) => ipcRenderer.invoke('tts-create-background-image', text),
        // 現在設定されている背景画像のパスを取得
        getCurrentBackground: () => ipcRenderer.invoke('tts-get-current-background'),
        uploadToYoutube: () => ipcRenderer.invoke('tts-upload-youtube'),
        setAutoUploadToYoutube: (value) => ipcRenderer.invoke('tts-set-auto-upload-youtube', value),
        // スピーカー動画プレフィックス設定
        setSpeakerVideoPrefix: (prefix) => ipcRenderer.invoke('tts-set-speaker-video-prefix', prefix),
        // YouTube認証関連の機能を追加
        hasYoutubeCredentials: async () => {
            try {
                const result = await ipcRenderer.invoke('tts-has-youtube-credentials');
                return !!result?.hasCredentials;
            } catch (error) {
                console.error('Failed to check YouTube credentials:', error);
                return false;
            }
        },
        getYoutubeTokenFiles: async () => {
            try {
                const result = await ipcRenderer.invoke('tts-get-youtube-token-files');
                return Array.isArray(result?.tokens) ? result.tokens : [];
            } catch (error) {
                console.error('Failed to get YouTube token files:', error);
                return [];
            }
        },
        checkYoutubeAuth: () => ipcRenderer.invoke('tts-check-youtube-auth'),
        getYoutubeAuthUrl: () => ipcRenderer.invoke('tts-get-youtube-auth-url'),
        cancelYoutubeAuth: () => ipcRenderer.invoke('tts-cancel-youtube-auth'),
        submitYoutubeAuthCode: (code) => ipcRenderer.invoke('tts-submit-youtube-auth-code', code),
        setYoutubeTokenFile: (tokenFile) => ipcRenderer.invoke('tts-set-youtube-token-file', tokenFile),
        onYoutubeAuthComplete: (callback) => {
            const removeListener = (event, data) => callback(data);
            ipcRenderer.on('tts-youtube-auth-complete', removeListener);
            return () => ipcRenderer.removeListener('tts-youtube-auth-complete', removeListener);
        },
        // ローカル画像をBase64に変換する関数
        getLocalImageAsBase64: (filePath) => ipcRenderer.invoke('tts-get-local-image-as-base64', filePath),
        // 動画ファイルからサムネイルを生成する関数
        generateThumbnailFromVideo: (videoPath) => ipcRenderer.invoke('tts-generate-thumbnail-from-video', videoPath),
        // クリップボードからファイルパスを取得する関数
        getClipboardFilePath: () => ipcRenderer.invoke('tts-get-clipboard-file-path'),
        // ドロップされたファイルを一時保存する関数
        saveUploadedFile: async (file) => {
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = async () => {
                    try {
                        const buffer = Buffer.from(reader.result);
                        const result = await ipcRenderer.invoke('tts-save-uploaded-file', {
                            name: file.name,
                            type: file.type,
                            buffer: buffer
                        });
                        resolve(result);
                    } catch (error) {
                        reject(error);
                    }
                };
                reader.onerror = (error) => reject(error);
                reader.readAsArrayBuffer(file);
            });
        },
        // BGM関連
        getBgms: () => ipcRenderer.invoke('tts-get-bgms'),
        setBgm: (bgmPath) => ipcRenderer.invoke('tts-set-bgm', bgmPath),
        setBgmVolume: (volume) => ipcRenderer.invoke('tts-set-bgm-volume', volume),
        // 字幕（drawtext）表示ON/OFF
        setCaptionsEnabled: (enabled) => ipcRenderer.invoke('tts-set-captions-enabled', enabled),
        // イントロ背景動画関連
        getIntroBgVideos: () => ipcRenderer.invoke('tts-get-intro-bg-videos'),
        setIntroBgVideo: (videoNameOrPath) => ipcRenderer.invoke('tts-set-intro-bg-video', videoNameOrPath),
        readJsonFile: async (filePath) => {
            try {
                return await ipcRenderer.invoke('tts-read-json-file', filePath);
            } catch (error) {
                console.error('Failed to read JSON file:', error);
                return { success: false, error: error.message };
            }
        }
    },
});
