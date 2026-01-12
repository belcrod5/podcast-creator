const React = require('react');
const { createContext, useContext, useState, useCallback, useEffect } = require('react');
const { v4: uuidv4 } = require('uuid');

const PodCastContext = createContext(null);
const tts = window.electron.tts;

// キューアイテムの初期状態
const initialQueueItem = {
    script: {
        text: '',
        speakerId: ''
    },
    youtubeInfo: {
        title: '',
        description: '',
        tags: '',
        categoryId: '22',
        thumbnailPath: ''
    },
    backgroundImage: null,
    speakerVideoPrefix: '',
    // 動画形式（PodCastCreatorでキュー追加時に保存される）
    // - landscape: 1920x1080
    // - short: 1080x1920
    videoFormat: 'landscape',
    status: 'waiting',
    progress: {
        generating: 0,
        video: 0,
        upload: 0
    }
};

const LANGUAGE_CODES = {
    JAPANESE: 'ja',
    ENGLISH: 'en'
};

const normalizeLanguage = (value) => (
    typeof value === 'string' && value.toLowerCase() === LANGUAGE_CODES.ENGLISH
        ? LANGUAGE_CODES.ENGLISH
        : LANGUAGE_CODES.JAPANESE
);

exports.PodCastProvider = ({ children }) => {
    // キュー管理
    const [queue, setQueue] = useState([]);
    const [currentQueueIndex, setCurrentQueueIndex] = useState(-1);
    const [isProcessing, setIsProcessing] = useState(false);
    const [currentProgressStage, setCurrentProgressStage] = useState(null);

    // 共通設定
    const [playbackSpeed, setPlaybackSpeed] = useState(1.0);
    const [replacementText, setReplacementText] = useState('');
    const [autoUploadToYoutube, setAutoUploadToYoutubeState] = useState(true);
    const [youtubeTokenFile, setYoutubeTokenFileState] = useState(() => {
        try {
            return localStorage.getItem('youtube-token-file') || '';
        } catch (_) {
            return '';
        }
    });

    // 自動アップロード設定は毎回ONで初期化（保存しない）
    useEffect(() => {
        setAutoUploadToYoutubeState(true);
        tts.setAutoUploadToYoutube(true).catch(() => {});
    }, []);

    // 自動アップロード設定の更新（React→Node 反映）
    const setAutoUploadToYoutube = useCallback(async (newValue) => {
        setAutoUploadToYoutubeState(newValue);
        try {
            await tts.setAutoUploadToYoutube(newValue);
        } catch (error) {
            console.error('YouTube自動アップロード設定の更新に失敗しました:', error);
        }
    }, []);

    const setYoutubeTokenFile = useCallback((tokenFile) => {
        if (typeof tokenFile !== 'string') {
            setYoutubeTokenFileState('');
            return;
        }
        const trimmed = tokenFile.trim();
        setYoutubeTokenFileState(trimmed);
    }, []);

    useEffect(() => {
        try {
            if (youtubeTokenFile) {
                localStorage.setItem('youtube-token-file', youtubeTokenFile);
            } else {
                localStorage.removeItem('youtube-token-file');
            }
        } catch (_) {
            /* ignore */
        }
        if (youtubeTokenFile) {
            tts.setYoutubeTokenFile(youtubeTokenFile).catch(error => {
                console.error('YouTubeトークンファイルの設定に失敗しました:', error);
            });
        }
    }, [youtubeTokenFile]);

    // イベントリスナーの設定
    useEffect(() => {
        const onProgress = (_, data) => {
            if (!isProcessing) return;
            
            console.log(`[PodCastContext] Progress - Type: ${data.type}, Value: ${data.progress}, Queue Index: ${currentQueueIndex}, Queue Length: ${queue.length}`);
            if (data && (data.type === 'generating' || data.type === 'video' || data.type === 'upload')) {
                setCurrentProgressStage(data.type);
            }

            setQueue(prevQueue => {
                const newQueue = [...prevQueue];
                const currentItem = newQueue[currentQueueIndex];
                if (!currentItem) return prevQueue;

                // 進捗の更新
                switch (data.type) {
                    case 'generating':
                        currentItem.progress.generating = data.progress;
                        break;
                    case 'video':
                        currentItem.progress.video = data.progress;
                        break;
                    case 'upload':
                        currentItem.progress.upload = data.progress;
                        break;
                }
                return newQueue;
            });
        };

        const removeListener = tts.onProgress(onProgress);
        return () => removeListener();
    }, [isProcessing, currentQueueIndex, queue.length]);

    useEffect(() => {
        const onProcessingComplete = (_, data) => {
            if (!isProcessing) return;

            setCurrentProgressStage(null);
            setQueue(prevQueue => {
                const newQueue = [...prevQueue];
                const currentItem = newQueue[currentQueueIndex];
                if (!currentItem) return prevQueue;
                if (currentItem.status !== 'completed') {
                    currentItem.status = 'completed';
                }
                return newQueue;
            });

            console.log('[PodCastContext] 処理完了イベントを受信しました。次のキューへ進みます。');
            setTimeout(() => processNextQueue(), 1000);
        };

        const removeListener = tts.onProcessingComplete(onProcessingComplete);
        return () => removeListener();
    }, [isProcessing, currentQueueIndex, processNextQueue]);

    // テキストの置換処理
    const replaceText = useCallback((originalText) => {
        const replacements = replacementText
            .split('\n')
            .filter(line => line.includes('='))
            .reduce((acc, line) => {
                const [from, to] = line.split('=').map(s => s.trim());
                if (from && to !== undefined) {
                    acc[from] = to;
                }
                return acc;
            }, {});

        let processedText = originalText;
        Object.entries(replacements).forEach(([from, to]) => {
            processedText = processedText.replaceAll(from, to);
        });
        return processedText;
    }, [replacementText]);

    // キューの追加
    const addToQueue = useCallback((item) => {
        const newItem = {
            ...initialQueueItem,
            ...item,
            id: uuidv4(),
            status: 'waiting'
        };
        setQueue(prev => [...prev, newItem]);
    }, []);

    // キューの削除
    const removeFromQueue = useCallback((id) => {
        setQueue(prev => prev.filter(item => item.id !== id));
    }, []);

    // キューアイテムの更新
    const updateQueueItem = useCallback((id, updates) => {
        setQueue(prev => prev.map(item => {
            if (item.id === id) {
                // 深いマージを行う
                const updatedItem = { ...item };
                Object.keys(updates).forEach(key => {
                    if (typeof updates[key] === 'object' && updates[key] !== null && !Array.isArray(updates[key])) {
                        // オブジェクトの場合は深いマージ
                        updatedItem[key] = {
                            ...updatedItem[key],
                            ...updates[key]
                        };
                    } else {
                        // プリミティブ値の場合は直接代入
                        updatedItem[key] = updates[key];
                    }
                });
                
                // 処理中のキューアイテムのyoutubeInfoが更新された場合、TTSサービスにも反映
                if (isProcessing && currentQueueIndex >= 0 && item.id === prev[currentQueueIndex]?.id && updates.youtubeInfo) {
                    console.log('処理中のキューのYouTube情報を更新します:', updatedItem.youtubeInfo);
                    // 非同期でTTSサービスに反映（エラーが発生してもUIは更新される）
                    tts.setYoutubeInfo(updatedItem.youtubeInfo).catch(error => {
                        console.error('YouTube情報の動的更新に失敗しました:', error);
                    });
                }
                
                return updatedItem;
            }
            return item;
        }));
    }, [isProcessing, currentQueueIndex]);

    // キューの処理
    const processQueue = useCallback(async (queueItem) => {
        try {

            // テキストの処理と再生開始
            const processedText = replaceText(queueItem.script.text);

            let datas = [];
            
            // textをJSONパースを試みる
            try {
                const json = JSON.parse(`{"datas":${processedText}}`);
                datas = json.datas;
            } catch (error) {
                console.warn('error', error);
                datas.push({text: processedText, id: queueItem.script.speakerId});
            }


            const scriptLanguage = normalizeLanguage(queueItem?.script?.language);
            const datasWithLanguage = datas.map((dataItem = {}) => {
                const normalized = typeof dataItem.language === 'string'
                    ? normalizeLanguage(dataItem.language)
                    : scriptLanguage;
                return {
                    ...dataItem,
                    language: normalized
                };
            });

            await tts.playAudio(
                datasWithLanguage,
                0,  // overlapDuration
                playbackSpeed,
                false,
                { language: scriptLanguage, videoFormat: queueItem?.videoFormat }
            );

            // 生成中はポーズ TODO: １つ目は再生されてしまう
            await tts.pauseAudio();

            // 自動生成とアップロードの設定を先に行う
            await tts.setAutoGenerateVideo(true);
            await tts.setAutoUploadToYoutube(autoUploadToYoutube);
            await tts.setYoutubeTokenFile(youtubeTokenFile);
            
            // スピーカー動画プレフィックスを設定
            if (queueItem.speakerVideoPrefix !== undefined) {
                await tts.setSpeakerVideoPrefix(queueItem.speakerVideoPrefix);
            }

            // YouTube情報の設定
            await tts.setYoutubeInfo(queueItem.youtubeInfo);

            // 背景画像の設定（Base64からバイナリデータに変換）
            /*if (queueItem.backgroundImage?.base64) {
                const base64String = queueItem.backgroundImage.base64.split(',')[1];
                const binaryString = atob(base64String);
                const bytes = new Uint8Array(binaryString.length);
                for (let i = 0; i < binaryString.length; i++) {
                    bytes[i] = binaryString.charCodeAt(i);
                }
                await tts.saveBackgroundImage(bytes);
            }*/

            // 背景画像の作成
            await tts.createBackgroundImage(queueItem.backgroundImage.text || queueItem.youtubeInfo.title);


            return true;
        } catch (error) {
            console.error('Queue processing error:', error);
            return false;
        }
    }, [playbackSpeed, replaceText, autoUploadToYoutube, youtubeTokenFile]);

    // 次のキューの処理
    const processNextQueue = useCallback(async () => {
        console.log(`[PodCastContext] processNextQueue 呼び出し。現在のインデックス: ${currentQueueIndex}, キュー長: ${queue.length}`);
        
        const nextIndex = currentQueueIndex + 1;
        if (nextIndex >= queue.length) {
            console.log(`[PodCastContext] すべてのキューの処理が完了しました。処理を終了します。`);
            setIsProcessing(false);
            setCurrentQueueIndex(-1);
            setCurrentProgressStage(null);
            return;
        }

        // Reactの状態更新を使用して状態を変更する
        setCurrentQueueIndex(nextIndex);
        
        console.log(`[PodCastContext] 次のキュー(${nextIndex})を処理します。`);
        
        // キューのステータスを更新する前に最新のキュー状態を取得
        setQueue(prevQueue => {
            const newQueue = [...prevQueue];
            if (newQueue[nextIndex]) {
                console.log(`[PodCastContext] キュー項目のステータスを "processing" に設定します: ${newQueue[nextIndex].youtubeInfo.title}`);
                newQueue[nextIndex].status = 'processing';
            }
            return newQueue;
        });
        
        // 状態が更新された後に処理を遅延実行
        setTimeout(async () => {
            // 最新のキュー状態を取得
            const currentQueue = queue;
            const nextItem = currentQueue[nextIndex];
            
            if (!nextItem) {
                console.log(`[PodCastContext] エラー: キュー項目が見つかりません。インデックス: ${nextIndex}`);
                return;
            }
            
            console.log(`[PodCastContext] キュー処理開始: ${nextItem.youtubeInfo.title}`);
            setCurrentProgressStage('generating');
            const success = await processQueue(nextItem);
            
            if (!success) {
                console.log(`[PodCastContext] キュー処理に失敗しました。エラー処理を行います。`);
                // エラー状態の更新も同様にReactの状態更新を使用
                setQueue(prevQueue => {
                    const newQueue = [...prevQueue];
                    if (newQueue[nextIndex]) {
                        newQueue[nextIndex].status = 'error';
                    }
                    return newQueue;
                });
                // エラー時に次のキューを処理（少し遅延を入れて状態更新を確実に）
                setTimeout(() => processNextQueue(), 100);
            } else {
                console.log(`[PodCastContext] キュー処理が成功しました。upload完了イベントを待ちます。`);
                // 成功時はonProgressイベントのupload完了で次のキューに進む
            }
        }, 100);
    }, [queue, currentQueueIndex, processQueue]);

    // キュー処理の開始
    const startProcessing = useCallback(async () => {
        if (isProcessing || queue.length === 0) {
            console.log(`[PodCastContext] キュー処理を開始できません。isProcessing: ${isProcessing}, queue.length: ${queue.length}`);
            return;
        }
        
        console.log(`[PodCastContext] キュー処理を開始します。キュー数: ${queue.length}`);
        setIsProcessing(true);
        
        // 状態更新後に少し遅延を入れてから処理開始
        setTimeout(() => processNextQueue(), 100);
    }, [isProcessing, queue, processNextQueue]);

    // キュー処理の停止
    const stopProcessing = useCallback(async () => {
        setIsProcessing(false);
        setCurrentProgressStage(null);
        await tts.stopAudio();
    }, []);

    const value = {
        queue,
        isProcessing,
        currentQueueIndex,
        playbackSpeed,
        replacementText,
        autoUploadToYoutube,
        youtubeTokenFile,
        currentProgressStage,
        addToQueue,
        removeFromQueue,
        updateQueueItem,
        startProcessing,
        stopProcessing,
        setPlaybackSpeed,
        setReplacementText,
        setAutoUploadToYoutube,
        setYoutubeTokenFile
    };

    return <PodCastContext.Provider value={value}>{children}</PodCastContext.Provider>;
};

// カスタムフック
exports.usePodCast = () => {
    const context = useContext(PodCastContext);
    if (!context) {
        throw new Error('usePodCast must be used within a PodCastProvider');
    }
    return context;
}; 
