const React = require('react');
const { useState, useEffect, useRef, useCallback, useMemo } = require('react');
const {
    Box,
    Paper,
    Typography,
    Button,
    IconButton,
    Stack,
    Divider,
    Accordion,
    AccordionSummary,
    AccordionDetails,
    TextField,
    Slider,
    FormControl,
    FormLabel,
    InputLabel,
    Select,
    MenuItem,
    FormHelperText,
    FormControlLabel,
    Checkbox,
    Radio,
    RadioGroup,
    Dialog,
    DialogTitle,
    DialogContent,
    DialogActions,
    Link,
    CircularProgress,
    ImageList,
    ImageListItem,
    Table,
    TableBody,
    TableCell,
    TableContainer,
    TableHead,
    TableRow,
    Tooltip,
} = require('@mui/material');
const {
    ExpandMore,
    Add,
    PlayArrow,
    Stop,
    Close,
    OpenInNew,
} = require('@mui/icons-material');
const { usePodCast } = require('../contexts/PodCastContext');
const {
    normalizeScriptItems,
    adjustInsertVideoTimingsCore,
    parseTimeInput,
    formatTimeInput,
    sanitizeTimeValue,
    normalizeVideoTimes
} = require('../../shared/podcast-script');
const PodCastProgressBar = require('./PodCastProgressBar');
const path = require('path');
const PRESET_CONFIG_PATH = 'assets/data/podcastcreator-preset.json';
const YOUTUBE_TOKEN_CUSTOM_VALUE = '__YOUTUBE_TOKEN_CUSTOM__';
const YOUTUBE_TOKEN_CUSTOM_LABEL = '新規作成...';
const YOUTUBE_TOKEN_SELECT_LABEL = '選択してください';

const resolveLocalPath = (filePath) => {
    if (!filePath) return '';
    if (filePath.startsWith('http')) return filePath;
    if (filePath.startsWith('local-media://') || filePath.startsWith('local-media:')) return filePath;

    const toLocalMediaUrl = (absolutePath) => {
        if (!absolutePath) return '';
        if (absolutePath.startsWith('local-media://')) return absolutePath;
        try {
            let converted = absolutePath;
            if (typeof path === 'object' && path !== null && typeof path.normalize === 'function') {
                converted = path.normalize(absolutePath);
            }

            if (/^[a-zA-Z]:\\/.test(converted)) {
                const normalized = converted.replace(/\\/g, '/');
                return `local-media:///${encodeURI(normalized)}`;
            }

            if (converted.startsWith('/')) {
                return `local-media:///${encodeURI(converted)}`;
            }

            return converted;
        } catch (error) {
            console.error('Failed to convert to local-media URL:', error);
            return absolutePath;
        }
    };

    const hasIsAbsolute = path && typeof path.isAbsolute === 'function';
    const hasJoin = path && typeof path.join === 'function';

    const isAbsolutePath = (value) => {
        if (!value) return false;
        if (hasIsAbsolute) return path.isAbsolute(value);
        return /^(?:[a-zA-Z]:\\|\/|\\\\)/.test(value);
    };

    if (isAbsolutePath(filePath)) {
        return toLocalMediaUrl(filePath);
    }

    // プロジェクトルート基準の相対パスは local-media: スキームで配信する
    return `local-media:${encodeURI(filePath)}`;
};

// ---------------------------------------------
// 警告ダイアログ用の共通コンポーネント
// ---------------------------------------------
const UnknownIdsDialog = ({ open, onClose, idStatuses = [] }) => (
    <Dialog open={open} onClose={onClose} aria-labelledby="unknown-id-dialog-title">
        <DialogTitle id="unknown-id-dialog-title">不明なIDがあります</DialogTitle>
        <DialogContent dividers>
            {idStatuses.map(({ id, valid }) => (
                <Box key={id} sx={{ display: 'flex', alignItems: 'center', mb: 1 }}>
                    {!valid && (
                        <Box
                            component="svg"
                            sx={{
                                color: 'error.main',
                                mr: 1,
                                width: 20,
                                height: 20
                            }}
                            viewBox="0 0 24 24"
                        >
                            <path
                                fill="currentColor"
                                d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"
                            />
                        </Box>
                    )}
                    <Typography sx={{ color: valid ? 'success.main' : 'error.main' }}>
                        {id} : {valid ? '有効' : '無効'}
                    </Typography>
                </Box>
            ))}
        </DialogContent>
        <DialogActions>
            <Button onClick={onClose} autoFocus>
                OK
            </Button>
        </DialogActions>
    </Dialog>
);

const InsertVideoAdjustConfirmDialog = ({
    open,
    onCancel,
    onConfirm,
    unmatchedItems = []
}) => (
    <Dialog
        open={open}
        onClose={onCancel}
        aria-labelledby="insert-video-adjust-dialog-title"
    >
        <DialogTitle id="insert-video-adjust-dialog-title">
            調整データが見つからない挿入動画があります
        </DialogTitle>
        <DialogContent dividers>
            <Typography>
                以下の挿入動画は調整前時間に一致するマッピングが見つかりませんでした。
                一致した挿入動画のみ時間を更新して続行しますか？
            </Typography>
            <Stack spacing={1.5} sx={{ mt: 2 }}>
                {unmatchedItems.map((item, index) => (
                    <Box key={`${item.startTime}-${item.endTime}-${index}`} sx={{ p: 1, borderRadius: 1, bgcolor: 'action.hover' }}>
                        <Typography variant="body2">
                            開始: {item.startTime || '-'}, 終了: {item.endTime || '-'}
                        </Typography>
                        {item.text && (
                            <Typography variant="caption" color="text.secondary">
                                {item.text}
                            </Typography>
                        )}
                    </Box>
                ))}
            </Stack>
        </DialogContent>
        <DialogActions>
            <Button onClick={onCancel}>キャンセル</Button>
            <Button onClick={onConfirm} variant="contained">
                続行
            </Button>
        </DialogActions>
    </Dialog>
);

// ローカル画像プレビューコンポーネント
const LocalImagePreview = ({ filePath }) => {
    const [base64Image, setBase64Image] = useState('');
    const [error, setError] = useState(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const loadImage = async () => {
            if (!filePath) {
                setError('ファイルパスが指定されていません');
                setLoading(false);
                return;
            }

            try {
                setLoading(true);
                setError(null);
                const result = await window.electron.tts.getLocalImageAsBase64(filePath);
                if (result && result.base64) {
                    setBase64Image(result.base64);
                } else {
                    setError('画像の読み込みに失敗しました');
                }
            } catch (err) {
                console.error('ローカル画像の読み込みエラー:', err);
                setError('画像の読み込み中にエラーが発生しました');
            } finally {
                setLoading(false);
            }
        };

        loadImage();
    }, [filePath]);

    if (loading) {
        return (
            <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '300px' }}>
                <CircularProgress />
            </Box>
        );
    }

    if (error) {
        return (
            <Box sx={{ p: 2, textAlign: 'center' }}>
                <Typography color="error">{error}</Typography>
                <Typography variant="body2" sx={{ mt: 1 }}>
                    ファイルパス: {filePath}
                </Typography>
            </Box>
        );
    }

    return (
        <img
            src={base64Image}
            alt="ローカル画像"
            style={{
                maxWidth: '100%',
                maxHeight: 'calc(100vh - 100px)',
                objectFit: 'contain'
            }}
        />
    );
};

// キューアイテムのフォーム初期値
const initialFormState = {
    script: {
        text: '',
        speakerId: '',
        language: 'ja'
    },
    youtubeInfo: {
        title: '',
        description: '',
        tags: '',
        categoryId: '22',
        thumbnailPath: ''
    },
    backgroundImage: {
        text: ''
    },
    speakerVideoPrefix: localStorage.getItem('speaker-video-prefix') || ''
};

// 許可する画像形式の定数定義
const ALLOWED_IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'mov', 'mp4'];
const ALLOWED_IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'video/mp4', 'video/quicktime'];
const ALLOWED_VIDEO_EXTENSIONS = ['mp4', 'mov', 'avi', 'mkv', 'wmv', 'flv', 'webm'];
const ALLOWED_VIDEO_MIME_TYPES = ['video/mp4', 'video/quicktime', 'video/x-matroska', 'video/x-msvideo', 'video/x-ms-wmv', 'video/x-flv', 'video/webm'];
const INSERT_VIDEO_MATCH_TOLERANCE_SECONDS = 1;
const LANGUAGE_OPTIONS = [
    { value: 'ja', label: '日本語' },
    { value: 'en', label: '英語' }
];

const DEFAULT_INTRO_BG_VIDEO_OPTIONS = [''];
const DEFAULT_INSERT_VIDEO_PATH = 'videos/output.mp4';
const DEFAULT_INSERT_VIDEO_MAPPING_PATH = `${DEFAULT_INSERT_VIDEO_PATH}.json`;

// 動画の出力形式（横長/ショート）
// - landscape: 1920x1080
// - short: 1080x1920
// ※ キュー追加時の選択値をキューに保存（perQueue）し、後から切り替えても既存キューには影響しない
const VIDEO_FORMATS = {
    LANDSCAPE: 'landscape',
    SHORT: 'short'
};
const VIDEO_FORMAT_STORAGE_KEY = 'tts-video-format';
const normalizeVideoFormat = (value) => (
    value === VIDEO_FORMATS.SHORT ? VIDEO_FORMATS.SHORT : VIDEO_FORMATS.LANDSCAPE
);

// 画像形式チェック用のヘルパー関数
const isAllowedImageFormat = (filePathOrName, mimeType = null) => {
    // URLの場合で拡張子がない場合は許可
    if (filePathOrName.startsWith('http')) {
        const parts = filePathOrName.toLowerCase().split('.');
        // 拡張子がない場合（ドットがない、またはドットの後に何もない）は許可
        if (parts.length === 1 || parts[parts.length - 1].includes('/') || parts[parts.length - 1].includes('?')) {
            return true;
        }
    }

    // 拡張子チェック
    const extension = filePathOrName.toLowerCase().split('.').pop();
    const isValidExtension = ALLOWED_IMAGE_EXTENSIONS.includes(extension);

    // MIMEタイプチェック（提供されている場合）
    const isValidMimeType = mimeType ? ALLOWED_IMAGE_MIME_TYPES.includes(mimeType) : true;

    console.log('filePathOrName', filePathOrName);
    console.log('extension', extension);
    console.log('mimeType', mimeType);
    console.log('isValidExtension', isValidExtension);
    console.log('isValidMimeType', isValidMimeType);
    console.log('isValidExtension && isValidMimeType', isValidExtension && isValidMimeType);

    return isValidExtension && isValidMimeType;
};

const isAllowedVideoFormat = (filePathOrName, mimeType = null) => {
    if (!filePathOrName) return false;
    const extension = String(filePathOrName).toLowerCase().split('.').pop();
    const hasValidExtension = ALLOWED_VIDEO_EXTENSIONS.includes(extension);
    const hasValidMime = mimeType ? ALLOWED_VIDEO_MIME_TYPES.includes(mimeType) : true;
    return hasValidExtension && hasValidMime;
};

const defaultVideoEditData = {
    path: '',
    startTime: '00:00:00',
    endTime: '00:00:01'
};

const PodCastCreator = () => {
    const executeDeferredRef = useRef({ pending: false, timer: null });
    const adjustInsertVideoTimingsRef = useRef(null);
    const skipScriptTextSyncRef = useRef(false);

    const executeDeferredAdjust = useCallback(() => {
        if (executeDeferredRef.current.pending) {
            return;
        }

        executeDeferredRef.current.pending = true;
        executeDeferredRef.current.timer = setTimeout(async () => {
            executeDeferredRef.current.pending = false;
            executeDeferredRef.current.timer = null;

            try {
                const mappingResult = await window.electron?.tts?.readJsonFile?.(DEFAULT_INSERT_VIDEO_MAPPING_PATH);
                if (!mappingResult || !mappingResult.success || !mappingResult.data) {
                    console.warn('[InsertVideoAdjust] Mapping JSON の読み込みに失敗しました', mappingResult?.error);
                    return;
                }

                const runAdjust = typeof adjustInsertVideoTimingsRef.current === 'function'
                    ? adjustInsertVideoTimingsRef.current
                    : adjustInsertVideoTimings;

                await runAdjust({
                    source: 'file',
                    mappingData: mappingResult.data,
                    skipAlreadyProcessed: true
                });
            } catch (error) {
                console.error('[InsertVideoAdjust] 自動調整の実行に失敗しました', error);
            }
        }, 50);
    }, [adjustInsertVideoTimings]);

    const {
        queue,
        isProcessing,
        currentQueueIndex,
        playbackSpeed,
        replacementText,
        autoUploadToYoutube,
        youtubeTokenFile,
        addToQueue,
        removeFromQueue,
        startProcessing,
        stopProcessing,
        setPlaybackSpeed,
        setReplacementText,
        setAutoUploadToYoutube,
        setYoutubeTokenFile,
        updateQueueItem
    } = usePodCast();

    // 追加: 不明 ID ダイアログ制御ステート
    const [unknownIdsDialogOpen, setUnknownIdsDialogOpen] = useState(false);
    const [unknownIdStatuses, setUnknownIdStatuses] = useState([]);

    const [speakers, setSpeakers] = useState([]);
    const [englishSpeakers, setEnglishSpeakers] = useState([]);
    const [formData, setFormData] = useState(initialFormState);

    // YouTube認証関連の状態
    const [isYoutubeAuthChecking, setIsYoutubeAuthChecking] = useState(false);
    const [isYoutubeAuthenticated, setIsYoutubeAuthenticated] = useState(false);
    const [youtubeAuthUrl, setYoutubeAuthUrl] = useState('');
    const [youtubeAuthDialogOpen, setYoutubeAuthDialogOpen] = useState(false);
    const [youtubeAuthProcessing, setYoutubeAuthProcessing] = useState(false);
    const [youtubeAuthErrorMessage, setYoutubeAuthErrorMessage] = useState('');
    const [isYoutubeCredentialsAvailable, setIsYoutubeCredentialsAvailable] = useState(true);
    const [youtubeTokenFiles, setYoutubeTokenFiles] = useState([]);
    const [youtubeTokenOptions, setYoutubeTokenOptions] = useState([
        { value: '', label: YOUTUBE_TOKEN_SELECT_LABEL },
        { value: YOUTUBE_TOKEN_CUSTOM_VALUE, label: YOUTUBE_TOKEN_CUSTOM_LABEL }
    ]);
    const [selectedYoutubeToken, setSelectedYoutubeToken] = useState(() => youtubeTokenFile || '');
    const [youtubeTokenSelectValue, setYoutubeTokenSelectValue] = useState('');
    const [youtubeTokenCustomName, setYoutubeTokenCustomName] = useState('');
    const [youtubeTokenError, setYoutubeTokenError] = useState(false);
    const [youtubeTokenDialogOpen, setYoutubeTokenDialogOpen] = useState(false);

    // 画像URL入力ダイアログの状態
    const [imageSelectionDialogOpen, setImageSelectionDialogOpen] = useState(false);
    const [selectedImageUrl, setSelectedImageUrl] = useState('');

    // スクリプトアイテムの状態管理
    const [scriptItems, setScriptItems] = useState([]);
    const [editingImageIndex, setEditingImageIndex] = useState(-1);
    const [lastOpenedImageSearchIndex, setLastOpenedImageSearchIndex] = useState(-1);
    // BGM 選択
    const [bgmList, setBgmList] = useState([]);
    const [selectedBgm, setSelectedBgm] = useState('');
    const [introBgVideoList, setIntroBgVideoList] = useState([]);
    const [introBgVideoOptions, setIntroBgVideoOptions] = useState(DEFAULT_INTRO_BG_VIDEO_OPTIONS);
    const [selectedIntroBgVideo, setSelectedIntroBgVideo] = useState(() => {
        try {
            return localStorage.getItem('tts-intro-bg-video') || DEFAULT_INTRO_BG_VIDEO_OPTIONS[0];
        } catch (_) {
            return DEFAULT_INTRO_BG_VIDEO_OPTIONS[0];
        }
    });
    const [bgmVolume, setBgmVolume] = useState(() => {
        try {
            const saved = localStorage.getItem('tts-bgm-volume');
            if (!saved) return 0.2;
            const parsed = parseFloat(saved);
            return Number.isFinite(parsed) ? parsed : 0.2;
        } catch (_) {
            return 0.2;
        }
    });
    const [captionsEnabled, setCaptionsEnabled] = useState(() => {
        try {
            const saved = localStorage.getItem('tts-captions-enabled');
            if (saved === null) return true;
            return saved === 'true';
        } catch (_) {
            return true;
        }
    });
    const [videoFormat, setVideoFormat] = useState(() => {
        try {
            return normalizeVideoFormat(localStorage.getItem(VIDEO_FORMAT_STORAGE_KEY));
        } catch (_) {
            return VIDEO_FORMATS.LANDSCAPE;
        }
    });
    const [fixedYoutubeDescription, setFixedYoutubeDescription] = useState(() => {
        try {
            return localStorage.getItem('youtube-fixed-description') || '';
        } catch (_) {
            return '';
        }
    });

    // プリセット設定（ランタイムで読み込み）
    const [presetConfigData, setPresetConfigData] = useState(null);
    useEffect(() => {
        let cancelled = false;
        const loadPresetConfig = async () => {
            try {
                const result = await window.electron?.tts?.readJsonFile?.(PRESET_CONFIG_PATH);
                if (cancelled) return;
                if (result && result.success && result.data) {
                    setPresetConfigData(result.data);
                } else {
                    setPresetConfigData(null);
                }
            } catch (error) {
                console.warn('プリセット設定の読み込みに失敗しました:', error);
                if (!cancelled) {
                    setPresetConfigData(null);
                }
            }
        };
        loadPresetConfig();
        return () => {
            cancelled = true;
        };
    }, []);

    const presets = useMemo(() => {
        const config = presetConfigData;
        if (!config) return [];
        if (Array.isArray(config)) return config;
        if (Array.isArray(config.presets)) return config.presets;
        return [];
    }, [presetConfigData]);
    const [presetDialogOpen, setPresetDialogOpen] = useState(true);
    const [pendingPreset, setPendingPreset] = useState(null);
    const [selectedPresetId, setSelectedPresetId] = useState(() => presets[0]?.id || '');
    const hasPresets = presets.length > 0;

    const normalizedYoutubeTokenCustomName = (typeof youtubeTokenCustomName === 'string')
        ? youtubeTokenCustomName.trim()
        : '';
    const isYoutubeTokenCustomValid = !normalizedYoutubeTokenCustomName
        || normalizedYoutubeTokenCustomName.toLowerCase().endsWith('.json');
    const youtubeControlsDisabled = !isYoutubeCredentialsAvailable;
    const youtubeTokenSelectDisabled = youtubeControlsDisabled || !autoUploadToYoutube;

    const refreshYoutubeTokenFiles = useCallback(async () => {
        try {
            const hasCredentials = await (window.electron?.tts?.hasYoutubeCredentials?.() ?? false);
            setIsYoutubeCredentialsAvailable(!!hasCredentials);
            if (!hasCredentials) {
                setYoutubeTokenFiles([]);
                setYoutubeTokenOptions([
                    { value: '', label: YOUTUBE_TOKEN_SELECT_LABEL },
                    { value: YOUTUBE_TOKEN_CUSTOM_VALUE, label: YOUTUBE_TOKEN_CUSTOM_LABEL }
                ]);
                return;
            }

            const files = await (window.electron?.tts?.getYoutubeTokenFiles?.() ?? []);
            const normalized = Array.isArray(files)
                ? files.filter((name) => typeof name === 'string' && name.trim()).map((name) => name.trim())
                : [];

            setYoutubeTokenFiles(normalized);
            setYoutubeTokenOptions([
                { value: '', label: YOUTUBE_TOKEN_SELECT_LABEL },
                ...normalized.map((name) => ({ value: name, label: name })),
                { value: YOUTUBE_TOKEN_CUSTOM_VALUE, label: YOUTUBE_TOKEN_CUSTOM_LABEL }
            ]);
        } catch (error) {
            console.error('YouTubeトークン一覧の取得に失敗しました:', error);
            setIsYoutubeCredentialsAvailable(false);
            setYoutubeTokenFiles([]);
            setYoutubeTokenOptions([
                { value: '', label: YOUTUBE_TOKEN_SELECT_LABEL },
                { value: YOUTUBE_TOKEN_CUSTOM_VALUE, label: YOUTUBE_TOKEN_CUSTOM_LABEL }
            ]);
        }
    }, []);

    // スピーカー動画プレフィックス
    const [speakerVideoPrefix, setSpeakerVideoPrefix] = useState(
        localStorage.getItem('speaker-video-prefix') || ''
    );

    // プレフィックス変更時に永続化とバックエンドへ通知
    useEffect(() => {
        try {
            localStorage.setItem('speaker-video-prefix', speakerVideoPrefix);
        } catch (_) {
            /* ignore */
        }
    }, [speakerVideoPrefix]);

    useEffect(() => {
        try {
            localStorage.setItem('youtube-fixed-description', fixedYoutubeDescription);
        } catch (_) {
            /* ignore */
        }
    }, [fixedYoutubeDescription]);

    useEffect(() => {
        refreshYoutubeTokenFiles();
    }, [refreshYoutubeTokenFiles]);

    useEffect(() => {
        const normalized = (typeof selectedYoutubeToken === 'string') ? selectedYoutubeToken.trim() : '';
        if (!normalized) {
            if (youtubeTokenSelectValue !== YOUTUBE_TOKEN_CUSTOM_VALUE) {
                setYoutubeTokenSelectValue('');
                setYoutubeTokenCustomName('');
            }
            return;
        }
        if (youtubeTokenFiles.includes(normalized)) {
            setYoutubeTokenSelectValue(normalized);
            if (youtubeTokenCustomName) {
                setYoutubeTokenCustomName('');
            }
            return;
        }
        setYoutubeTokenSelectValue(YOUTUBE_TOKEN_CUSTOM_VALUE);
        if (normalized !== youtubeTokenCustomName) {
            setYoutubeTokenCustomName(normalized);
        }
    }, [selectedYoutubeToken, youtubeTokenFiles, youtubeTokenCustomName, youtubeTokenSelectValue]);

    useEffect(() => {
        if (!isYoutubeCredentialsAvailable) {
            setIsYoutubeAuthChecking(false);
            setIsYoutubeAuthenticated(false);
            setYoutubeAuthDialogOpen(false);
            setYoutubeTokenError(false);
            if (autoUploadToYoutube) {
                setAutoUploadToYoutube(false);
            }
        }
    }, [isYoutubeCredentialsAvailable, autoUploadToYoutube, setAutoUploadToYoutube]);

    useEffect(() => {
        if (!autoUploadToYoutube) {
            setYoutubeTokenError(false);
            setYoutubeTokenDialogOpen(false);
        }
    }, [autoUploadToYoutube]);

    const handlePresetSelect = useCallback((preset) => {
        if (!preset) {
            setPendingPreset(null);
            setPresetDialogOpen(false);
            return;
        }
        setPendingPreset(preset);
        setPresetDialogOpen(false);
    }, []);

    const handlePresetSkip = useCallback(() => {
        setPendingPreset(null);
        setPresetDialogOpen(false);
    }, []);

    const handlePresetDialogConfirm = useCallback(() => {
        const targetPreset = presets.find((preset) => preset.id === selectedPresetId) || presets[0] || null;
        handlePresetSelect(targetPreset || null);
    }, [handlePresetSelect, presets, selectedPresetId]);

    useEffect(() => {
        if (!presetDialogOpen) return;
        if (!selectedPresetId && presets[0]) {
            setSelectedPresetId(presets[0].id);
        }
    }, [presetDialogOpen, presets, selectedPresetId]);

    useEffect(() => {
        if (!pendingPreset) return;

        const applyPreset = async () => {
            if (Object.prototype.hasOwnProperty.call(pendingPreset, 'bgm')) {
                const presetBgm = (typeof pendingPreset.bgm === 'string') ? pendingPreset.bgm.trim() : '';
                if (!presetBgm) {
                    try {
                        await window.electron.tts.setBgm('');
                    } catch (error) {
                        console.error('プリセットのBGM解除に失敗しました:', error);
                    }
                    setSelectedBgm('');
                } else {
                    const targetBgm = bgmList.find((bgm) => bgm.fileName === presetBgm);
                    if (targetBgm?.path) {
                        try {
                            await window.electron.tts.setBgm(targetBgm.path);
                            setSelectedBgm(presetBgm);
                        } catch (error) {
                            console.error('プリセットのBGM設定に失敗しました:', error);
                        }
                    } else {
                        console.warn('プリセットに指定されたBGMが見つからないためスキップします:', presetBgm);
                        try {
                            await window.electron.tts.setBgm('');
                        } catch (_) { /* ignore */ }
                        setSelectedBgm('');
                    }
                }
            }

            if (Number.isFinite(pendingPreset.bgmVolume)) {
                const volume = Math.min(Math.max(Number(pendingPreset.bgmVolume), 0), 1);
                setBgmVolume(volume);
            }

            if (typeof pendingPreset.captionsEnabled === 'boolean') {
                setCaptionsEnabled(pendingPreset.captionsEnabled);
            }

            if (typeof pendingPreset.videoFormat === 'string' && pendingPreset.videoFormat.trim()) {
                setVideoFormat(normalizeVideoFormat(pendingPreset.videoFormat.trim()));
            }

            if (Number.isFinite(Number(pendingPreset.playbackSpeed))) {
                const clampedSpeed = Math.min(Math.max(Number(pendingPreset.playbackSpeed), 0.1), 2.0);
                setPlaybackSpeed(clampedSpeed);
            }

            // introBgVideo が未指定/空の場合は「イントロ無し」として扱う
            const normalizedIntroBgVideo = (typeof pendingPreset.introBgVideo === 'string')
                ? pendingPreset.introBgVideo.trim()
                : '';
            setSelectedIntroBgVideo(normalizedIntroBgVideo);

            if (typeof pendingPreset.fixedDescription === 'string') {
                setFixedYoutubeDescription(pendingPreset.fixedDescription);
            }

            if (typeof pendingPreset.lang === 'string' && pendingPreset.lang.trim()) {
                const lang = pendingPreset.lang.trim();
                const isValidLang = LANGUAGE_OPTIONS.some((option) => option.value === lang);
                if (isValidLang) {
                    setFormData((prev) => ({
                        ...prev,
                        script: {
                            ...prev.script,
                            language: lang
                        }
                    }));
                }
            }

            if (pendingPreset.youtubeToken) {
                const presetToken = (typeof pendingPreset.youtubeToken === 'string')
                    ? pendingPreset.youtubeToken.trim()
                    : '';
                if (presetToken) {
                    if (youtubeTokenFiles.includes(presetToken)) {
                        setYoutubeTokenSelectValue(presetToken);
                        setYoutubeTokenCustomName('');
                    } else {
                        setYoutubeTokenSelectValue(YOUTUBE_TOKEN_CUSTOM_VALUE);
                        setYoutubeTokenCustomName(presetToken);
                    }

                    if (presetToken !== selectedYoutubeToken) {
                        setSelectedYoutubeToken(presetToken);
                        if (setYoutubeTokenFile) {
                            setYoutubeTokenFile(presetToken);
                        }
                        if (isYoutubeCredentialsAvailable && autoUploadToYoutube) {
                            try {
                                await window.electron.tts.setYoutubeTokenFile(presetToken);
                                await checkYoutubeAuthStatus({ showDialogOnFail: true, tokenValue: presetToken });
                            } catch (error) {
                                console.error('プリセットのYouTubeトークン設定に失敗しました:', error);
                            }
                        }
                    }
                }
            }

            setPendingPreset(null);
        };

        applyPreset().catch((error) => {
            console.error('プリセットの適用に失敗しました:', error);
            setPendingPreset(null);
        });
    }, [pendingPreset, bgmList, selectedYoutubeToken, setYoutubeTokenFile, setSelectedBgm, setBgmVolume, setSelectedIntroBgVideo, setFixedYoutubeDescription, setPlaybackSpeed, checkYoutubeAuthStatus, youtubeTokenFiles, isYoutubeCredentialsAvailable, autoUploadToYoutube]);

    // 画像プレビュー用の状態
    const [previewImageUrl, setPreviewImageUrl] = useState('');
    const [imagePreviewOpen, setImagePreviewOpen] = useState(false);
    const [previewIsVideo, setPreviewIsVideo] = useState(false);
    const [previewVideoPath, setPreviewVideoPath] = useState('');

    // まず、ローディング状態を示す状態変数を追加
    const [isLoadingImagesFromJson, setIsLoadingImagesFromJson] = useState(false);

    // ステート変数の部分に追加
    const [dragOver, setDragOver] = useState(-1);
    const [videoDragOver, setVideoDragOver] = useState(-1);

    // 画像形式警告ダイアログの状態を追加
    const [gifWarningDialogOpen, setGifWarningDialogOpen] = useState(false);
    const [gifWarningMessage, setGifWarningMessage] = useState('');

    // 挿入動画編集ダイアログ
    const [videoEditDialogOpen, setVideoEditDialogOpen] = useState(false);
    const [editingVideoIndex, setEditingVideoIndex] = useState(-1);
    const [videoEditData, setVideoEditData] = useState(defaultVideoEditData);
    const [videoEditPlaying, setVideoEditPlaying] = useState(false);
    const videoPlayerRef = useRef(null);
    const resolvedVideoEditPath = useMemo(() => resolveLocalPath(videoEditData.path), [videoEditData.path]);
    const [videoAdjustConfirmOpen, setVideoAdjustConfirmOpen] = useState(false);
    const pendingVideoAdjustResultRef = useRef(null);

    // localStorageから初期値を読み込む
    useEffect(() => {
        const savedSpeed = parseFloat(localStorage.getItem('tts-speed')) || 1.0;
        const savedReplacement = localStorage.getItem('tts-replacement') || '';
        setPlaybackSpeed(savedSpeed);
        setReplacementText(savedReplacement);
    }, [setPlaybackSpeed, setReplacementText]);

    // YouTube認証状態をチェック
    useEffect(() => {
        if (!isYoutubeCredentialsAvailable || !autoUploadToYoutube || !youtubeTokenFile) {
            setIsYoutubeAuthChecking(false);
            setIsYoutubeAuthenticated(false);
            setYoutubeAuthDialogOpen(false);
            return;
        }

        checkYoutubeAuthStatus({ showDialogOnFail: false });
    }, [youtubeTokenFile, checkYoutubeAuthStatus, autoUploadToYoutube, isYoutubeCredentialsAvailable]);

    // BGM 一覧を読み込み（保存はしない）
    useEffect(() => {
        const loadBgms = async () => {
            try {
                const list = await window.electron.tts.getBgms();
                setBgmList(list || []);
                // 初期値は「なし」（BGM未指定の場合は合成しない）
                setSelectedBgm('');
                await window.electron.tts.setBgm('');
                await window.electron.tts.setBgmVolume(bgmVolume);
            } catch (e) {
                console.error('BGM一覧の取得に失敗:', e);
            }
        };
        loadBgms();
    }, []);

    // イントロ背景動画 一覧を読み込み（保存はしない）
    useEffect(() => {
        const loadIntroBgVideos = async () => {
            try {
                const list = await (window.electron?.tts?.getIntroBgVideos?.() ?? Promise.resolve([]));
                const normalized = Array.isArray(list) ? list : [];
                setIntroBgVideoList(normalized);

                const fileNames = normalized.map(item => item?.fileName).filter(Boolean);
                const options = Array.from(new Set([...DEFAULT_INTRO_BG_VIDEO_OPTIONS, ...fileNames]));
                setIntroBgVideoOptions(options);

                let initial = '';
                try {
                    const saved = localStorage.getItem('tts-intro-bg-video');
                    if (saved && options.includes(saved)) {
                        initial = saved;
                    }
                } catch (_) {
                    /* ignore */
                }

                // 初期値は localStorage のみ（未指定なら「なし」）
                setSelectedIntroBgVideo(initial || '');
            } catch (e) {
                console.error('イントロ背景動画一覧の取得に失敗:', e);
                setIntroBgVideoList([]);
                setIntroBgVideoOptions(DEFAULT_INTRO_BG_VIDEO_OPTIONS);
            }
        };
        loadIntroBgVideos();
    }, []);

    useEffect(() => {
        // 空文字は「イントロ無し」としてサービスへ通知する
        const value = (typeof selectedIntroBgVideo === 'string') ? selectedIntroBgVideo : '';
        window.electron.tts.setIntroBgVideo(value).catch((error) => {
            console.error('イントロ背景動画の設定に失敗しました:', error);
        });
        try {
            if (value) {
                localStorage.setItem('tts-intro-bg-video', value);
            } else {
                localStorage.removeItem('tts-intro-bg-video');
            }
        } catch (_) {
            /* ignore */
        }
    }, [selectedIntroBgVideo]);

    // YouTube認証URLを取得
    const handleGetYoutubeAuthUrl = useCallback(async () => {
        if (!isYoutubeCredentialsAvailable || !autoUploadToYoutube) {
            return null;
        }
        try {
            setYoutubeAuthErrorMessage('');
            const { authUrl } = await window.electron.tts.getYoutubeAuthUrl();
            if (!authUrl) {
                throw new Error('認証URLが取得できませんでした');
            }
            console.log('Got YouTube auth URL:', authUrl);
            setYoutubeAuthUrl(authUrl);
            return authUrl;
        } catch (error) {
            console.error('Failed to get YouTube auth URL:', error);
            throw error;
        }
    }, [isYoutubeCredentialsAvailable, autoUploadToYoutube]);

    const handleOpenYoutubeAuthPage = useCallback(async (event) => {
        if (event?.preventDefault) {
            event.preventDefault();
        }
        if (youtubeAuthProcessing) {
            return;
        }
        setYoutubeAuthProcessing(true);
        setYoutubeAuthErrorMessage('');
        try {
            const authUrl = await handleGetYoutubeAuthUrl();
            if (!authUrl) {
                throw new Error('認証URLが取得できませんでした');
            }
            if (window?.electron && typeof window.electron.openExternal === 'function') {
                const result = await window.electron.openExternal(authUrl);
                if (result && result.success === false) {
                    throw new Error(result.error || 'openExternal failed');
                }
            } else {
                window.open(authUrl, '_blank', 'noopener,noreferrer');
            }
        } catch (error) {
            console.error('Failed to open YouTube auth page:', error);
            try {
                await window.electron?.tts?.cancelYoutubeAuth?.();
            } catch (cancelError) {
                console.error('Failed to cancel YouTube auth after error:', cancelError);
            }
            setYoutubeAuthProcessing(false);
            setYoutubeAuthErrorMessage('認証ページを開けませんでした。もう一度お試しください。');
        }
    }, [handleGetYoutubeAuthUrl, youtubeAuthProcessing]);

    const handleCloseYoutubeAuthDialog = useCallback(async () => {
        try {
            await window.electron?.tts?.cancelYoutubeAuth?.();
        } catch (error) {
            console.error('Failed to cancel YouTube auth:', error);
        }
        setYoutubeAuthProcessing(false);
        setYoutubeAuthDialogOpen(false);
        setYoutubeAuthErrorMessage('');
        setYoutubeAuthUrl('');
    }, []);

    const checkYoutubeAuthStatus = useCallback(async ({ showDialogOnFail = false, tokenValue } = {}) => {
        const normalizedToken = (typeof tokenValue === 'string') ? tokenValue.trim() : '';
        const effectiveToken = normalizedToken || (typeof youtubeTokenFile === 'string' ? youtubeTokenFile.trim() : '');
        if (!isYoutubeCredentialsAvailable || !autoUploadToYoutube || !effectiveToken) {
            try {
                await window.electron?.tts?.cancelYoutubeAuth?.();
            } catch (error) {
                console.error('Failed to cancel YouTube auth during reset:', error);
            }
            setIsYoutubeAuthChecking(false);
            setIsYoutubeAuthenticated(false);
            setYoutubeAuthDialogOpen(false);
            setYoutubeAuthProcessing(false);
            setYoutubeAuthErrorMessage('');
            setYoutubeAuthUrl('');
            return;
        }

        setIsYoutubeAuthChecking(true);
        try {
            const { isAuthenticated } = await window.electron.tts.checkYoutubeAuth();
            console.log('YouTube auth check result:', isAuthenticated);
            setIsYoutubeAuthenticated(isAuthenticated);

            if (!isAuthenticated && showDialogOnFail) {
                setYoutubeAuthErrorMessage('');
                setYoutubeAuthProcessing(false);
                setYoutubeAuthUrl('');
                setYoutubeAuthDialogOpen(true);
            }

            if (isAuthenticated) {
                setYoutubeAuthDialogOpen(false);
                setYoutubeAuthProcessing(false);
            }
        } catch (error) {
            console.error('Failed to check YouTube auth:', error);
            setIsYoutubeAuthenticated(false);
            if (showDialogOnFail) {
                setYoutubeAuthErrorMessage('');
                setYoutubeAuthProcessing(false);
                setYoutubeAuthUrl('');
                setYoutubeAuthDialogOpen(true);
            }
        } finally {
            setIsYoutubeAuthChecking(false);
        }
    }, [youtubeTokenFile, autoUploadToYoutube, isYoutubeCredentialsAvailable]);

    useEffect(() => {
        if (!window?.electron?.tts?.onYoutubeAuthComplete) {
            return undefined;
        }
        const dispose = window.electron.tts.onYoutubeAuthComplete(async (payload) => {
            if (payload?.success) {
                setYoutubeAuthProcessing(false);
                setYoutubeAuthDialogOpen(false);
                setYoutubeAuthErrorMessage('');
                setYoutubeAuthUrl('');
                setIsYoutubeAuthenticated(true);
                await refreshYoutubeTokenFiles();
                await checkYoutubeAuthStatus({ showDialogOnFail: false });
                return;
            }
            const message = payload?.error || '認証に失敗しました。もう一度お試しください。';
            setYoutubeAuthProcessing(false);
            setYoutubeAuthErrorMessage(message);
        });
        return dispose;
    }, [checkYoutubeAuthStatus, refreshYoutubeTokenFiles]);

    const handleVideoDropReplace = async (index, file) => {
        if (!file || !scriptItems[index]) return;

        try {
            if (!isAllowedVideoFormat(file.name, file.type)) {
                alert('動画ファイルのみサポートされています。対応形式: mp4, mov, avi, mkv, wmv, flv, webm');
                return;
            }

            const result = await window.electron.tts.saveUploadedFile(file);
            if (!result.success || !result.filePath) {
                throw new Error('動画の保存に失敗しました');
            }

            const videoPath = result.filePath;
            const updatedItems = [...scriptItems];
            const { startTime, endTime } = normalizeVideoTimes(
                updatedItems[index].startTime || '00:00:00',
                updatedItems[index].endTime || '00:00:01'
            );
            const startSeconds = parseTimeInput(startTime);
            const endSeconds = parseTimeInput(endTime);

            updatedItems[index] = {
                ...updatedItems[index],
                insert_video: videoPath,
                path: videoPath,
                videoPath,
                localPath: videoPath,
                startTime,
                endTime,
                videoStartOffset: startSeconds,
                videoEndOffset: endSeconds,
                duration: Math.max(1, endSeconds - startSeconds)
            };

            updateScriptItems(updatedItems);
        } catch (error) {
            console.error('動画の置き換えに失敗しました:', error);
            alert(`動画の置き換えに失敗しました: ${error.message}`);
        }
    };

    const applyYoutubeTokenSelection = useCallback(async (tokenValue) => {
        const trimmed = (typeof tokenValue === 'string') ? tokenValue.trim() : '';
        setSelectedYoutubeToken(trimmed);
        if (setYoutubeTokenFile) {
            setYoutubeTokenFile(trimmed);
        }
        if (!trimmed) {
            setYoutubeAuthDialogOpen(false);
            setIsYoutubeAuthenticated(false);
            return;
        }
        try {
            await window.electron.tts.setYoutubeTokenFile(trimmed);
            await checkYoutubeAuthStatus({ showDialogOnFail: true, tokenValue: trimmed });
        } catch (error) {
            console.error('Failed to set YouTube token file:', error);
        }
    }, [setYoutubeTokenFile, checkYoutubeAuthStatus]);

    const handleYoutubeTokenSelectChange = useCallback(async (event) => {
        const tokenFile = event.target.value;
        setYoutubeTokenSelectValue(tokenFile);
        if (youtubeTokenError) {
            setYoutubeTokenError(false);
        }
        if (tokenFile === YOUTUBE_TOKEN_CUSTOM_VALUE) {
            const nextToken = isYoutubeTokenCustomValid ? normalizedYoutubeTokenCustomName : '';
            await applyYoutubeTokenSelection(nextToken);
            return;
        }
        setYoutubeTokenCustomName('');
        await applyYoutubeTokenSelection(tokenFile);
    }, [youtubeTokenError, normalizedYoutubeTokenCustomName, isYoutubeTokenCustomValid, applyYoutubeTokenSelection]);

    const handleYoutubeTokenCustomChange = useCallback((event) => {
        if (youtubeTokenError) {
            setYoutubeTokenError(false);
        }
        setYoutubeTokenCustomName(event.target.value);
    }, [youtubeTokenError]);

    const handleYoutubeTokenCustomBlur = useCallback(async () => {
        if (youtubeTokenSelectValue !== YOUTUBE_TOKEN_CUSTOM_VALUE) {
            return;
        }
        if (!isYoutubeTokenCustomValid) {
            return;
        }
        await applyYoutubeTokenSelection(normalizedYoutubeTokenCustomName);
    }, [applyYoutubeTokenSelection, normalizedYoutubeTokenCustomName, isYoutubeTokenCustomValid, youtubeTokenSelectValue]);

    // 再生速度の変更を保存
    useEffect(() => {
        localStorage.setItem('tts-speed', playbackSpeed.toString());
    }, [playbackSpeed]);

    // 置換テキストの変更を保存
    useEffect(() => {
        localStorage.setItem('tts-replacement', replacementText);
    }, [replacementText]);

    // 話者リストの取得と話者選択の初期化
    useEffect(() => {
        const loadSpeakers = async () => {
            try {
                const speakerList = await window.electron.tts.getSpeakers();
                setSpeakers(speakerList);

                try {
                    const enSpeakers = await window.electron.tts.getEnglishSpeakers();
                    setEnglishSpeakers(enSpeakers);
                } catch (e) {
                    console.error('Failed to load English speakers:', e);
                }

                const savedSpeaker = localStorage.getItem('tts-speaker');
                const flattened = speakerList.flatMap((s) => (s.styles || []).map((style) => style.id?.toString() ?? '').filter(Boolean));
                const fallback = flattened[0] || '';
                const initialValue = savedSpeaker && flattened.includes(savedSpeaker) ? savedSpeaker : fallback;

                if (initialValue) {
                    setFormData(prev => ({
                        ...prev,
                        script: {
                            ...prev.script,
                            speakerId: initialValue
                        }
                    }));
                    if (savedSpeaker !== initialValue) {
                        localStorage.setItem('tts-speaker', initialValue);
                    }
                }
            } catch (error) {
                console.error('Failed to load speakers:', error);
            }
        };
        loadSpeakers();
    }, []);

    // 話者選択が変更されたときにlocalStorageに保存
    const handleFormChange = (section, field) => (event) => {
        const newValue = event.target.value;
        setFormData(prev => ({
            ...prev,
            [section]: {
                ...prev[section],
                [field]: newValue
            }
        }));

        // 話者が変更された場合はlocalStorageに保存
        if (section === 'script' && field === 'speakerId') {
            localStorage.setItem('tts-speaker', newValue);
        }
    };

    // 背景画像の設定
    const handleImagePaste = async () => {
        try {
            // クリップボードからデータを取得
            const clipboardItems = await navigator.clipboard.read();

            for (const clipboardItem of clipboardItems) {
                // 画像タイプを探す
                const imageTypes = clipboardItem.types.filter(type => type.startsWith('image/'));

                if (imageTypes.length > 0) {
                    const blob = await clipboardItem.getType(imageTypes[0]);

                    // BlobをBase64に変換
                    const reader = new FileReader();
                    reader.onloadend = () => {
                        setFormData(prev => ({
                            ...prev,
                            backgroundImage: {
                                base64: reader.result,
                                name: 'Pasted Image'
                            }
                        }));
                    };
                    reader.readAsDataURL(blob);
                    break;
                }
            }
        } catch (error) {
            console.error('Failed to paste image:', error);
        }
    };

    // handleJsonPaste関数を更新してローディング状態を管理
    const handleJsonPaste = async () => {
        try {
            // ローディング開始
            setIsLoadingImagesFromJson(true);

            const text = await navigator.clipboard.readText();
            const data = JSON.parse(text);

            // スクリプトデータの設定
            if (data.script && data.script.length > 0) {
                // スクリプトアイテムを設定
                const scriptData = normalizeScriptItems([...data.script], { defaultInsertVideoPath: DEFAULT_INSERT_VIDEO_PATH });

                setScriptItems(scriptData);

                setFormData(prev => ({
                    ...prev,
                    script: {
                        ...prev.script,
                        text: JSON.stringify(scriptData)
                    }
                }));
            }

            // YouTube情報の設定
            if (data.youtube) {
                const youtubeTitle = data.youtube.title || '';
                setFormData(prev => ({
                    ...prev,
                    youtubeInfo: {
                        title: youtubeTitle,
                        description: data.youtube.description || '',
                        tags: Array.isArray(data.youtube.tags) ? data.youtube.tags.join(',') : data.youtube.tags,
                        categoryId: data.youtube.category || '22',
                        thumbnailPath: data.youtube.thumbnailPath || ''
                    },
                    // YouTubeタイトルが存在する場合、背景画像テキストにも設定
                    backgroundImage: {
                        ...prev.backgroundImage,
                        text: youtubeTitle
                    }
                }));
                if (typeof data.youtube.fixedDescription === 'string') {
                    setFixedYoutubeDescription(data.youtube.fixedDescription);
                }
            }

            executeDeferredAdjust();
        } catch (error) {
            console.error('Failed to parse clipboard data:', error);
        } finally {
            // 処理完了後、ローディング状態を解除
            setIsLoadingImagesFromJson(false);
        }
    };

    // スクリプトテキストが変更されたときにスクリプトアイテムを更新
    useEffect(() => {
        if (skipScriptTextSyncRef.current) {
            skipScriptTextSyncRef.current = false;
            return;
        }

        try {
            if (formData.script.text) {
                const parsedItems = normalizeScriptItems(JSON.parse(formData.script.text), { defaultInsertVideoPath: DEFAULT_INSERT_VIDEO_PATH });
                if (Array.isArray(parsedItems)) {
                    setScriptItems(parsedItems);
                }
            }
        } catch (error) {
            // JSON解析エラーは無視
        }
    }, [formData.script.text]);

    // 画像変更ボタンが押されたときのハンドラー
    const handleChangeImage = (index) => {
        setEditingImageIndex(index);

        const item = scriptItems[index];

        if (!item) return;

        const currentUrl = typeof item.img === 'string' ? item.img : '';
        setSelectedImageUrl(currentUrl);
        setImageSelectionDialogOpen(true);
    };

    // 画像が選択されたときのハンドラー
    const handleImageSelected = (imageUrl) => {
        if (typeof editingImageIndex === 'number' && editingImageIndex >= 0 && editingImageIndex < scriptItems.length) {
            const updatedScriptItems = [...scriptItems];
            updatedScriptItems[editingImageIndex].img = imageUrl;

            updateScriptItems(updatedScriptItems);

            setImageSelectionDialogOpen(false);
            setSelectedImageUrl('');
            setEditingImageIndex(-1);
            return;
        }

        if (editingImageIndex !== -1) {
            handleThumbnailImageSelected(imageUrl, editingImageIndex);
        }
    };

    const handleVideoEditDialogOpen = (index) => {
        const item = scriptItems[index];
        if (!item || !item.insert_video) return;

        const videoPath = item.insert_video || item.path;
        if (!videoPath) return;

        const { startTime, endTime } = normalizeVideoTimes(item.startTime, item.endTime);

        setVideoEditData({
            path: videoPath,
            startTime,
            endTime
        });
        setEditingVideoIndex(index);
        setVideoEditDialogOpen(true);
        setVideoEditPlaying(false);

        setTimeout(() => {
            if (videoPlayerRef.current) {
                videoPlayerRef.current.currentTime = parseTimeInput(startTime);
            }
        }, 0);
    };

    const handleVideoEditDialogClose = () => {
        setVideoEditDialogOpen(false);
        setEditingVideoIndex(-1);
        setVideoEditData(defaultVideoEditData);
        setVideoEditPlaying(false);
    };

    const updateScriptItems = (items) => {
        const normalized = normalizeScriptItems(items, { defaultInsertVideoPath: DEFAULT_INSERT_VIDEO_PATH });
        setScriptItems(normalized);
        setFormData(prev => ({
            ...prev,
            script: {
                ...prev.script,
                text: JSON.stringify(normalized)
            }
        }));
    };

    const handleVideoEditTimeChange = (field, value) => {
        const sanitized = sanitizeTimeValue(value);
        setVideoEditData(prev => ({
            ...prev,
            [field]: sanitized
        }));
    };

    const applyVideoEditChanges = () => {
        if (editingVideoIndex < 0 || editingVideoIndex >= scriptItems.length) {
            handleVideoEditDialogClose();
            return;
        }

        const { startTime, endTime } = normalizeVideoTimes(videoEditData.startTime, videoEditData.endTime);
        const startSeconds = parseTimeInput(startTime);
        const endSeconds = parseTimeInput(endTime);
        const updatedItems = [...scriptItems];
        const target = { ...updatedItems[editingVideoIndex] };

        target.startTime = startTime;
        target.endTime = endTime;
        target.videoStartOffset = startSeconds;
        target.videoEndOffset = endSeconds;
        target.duration = Math.max(1, endSeconds - startSeconds);
        target.insert_video = target.insert_video || target.path || resolvedVideoEditPath;
        target.path = target.insert_video;

        updatedItems[editingVideoIndex] = target;
        updateScriptItems(updatedItems);
        handleVideoEditDialogClose();
    };

    const seekVideoToStart = useCallback(() => {
        const player = videoPlayerRef.current;
        if (!player) return;
        const startSeconds = parseTimeInput(videoEditData.startTime);
        if (!Number.isFinite(startSeconds)) return;
        try {
            player.currentTime = startSeconds;
        } catch (error) {
            /* ignore seek errors before metadata load */
        }
    }, [videoEditData.startTime]);

    const adjustVideoEditTime = (field, delta) => {
        const seconds = parseTimeInput(videoEditData[field]);
        const nextValue = Math.max(0, seconds + delta);
        handleVideoEditTimeChange(field, formatTimeInput(nextValue));
    };

    const handleVideoEditPlayToggle = () => {
        if (!videoPlayerRef.current) return;

        if (videoPlayerRef.current.paused) {
            videoPlayerRef.current.play().catch(() => { });
            setVideoEditPlaying(true);
        } else {
            videoPlayerRef.current.pause();
            setVideoEditPlaying(false);
        }
    };

    const handleVideoEditLoaded = () => {
        if (!videoPlayerRef.current) return;
        seekVideoToStart();
        setVideoEditPlaying(!videoPlayerRef.current.paused);
    };

    const handleVideoEditTimeUpdate = () => {
        const player = videoPlayerRef.current;
        if (!player || player.paused) return;
        const startSeconds = parseTimeInput(videoEditData.startTime);
        const endSeconds = parseTimeInput(videoEditData.endTime);
        if (!Number.isFinite(endSeconds) || !Number.isFinite(startSeconds)) return;
        if (player.currentTime >= endSeconds) {
            seekVideoToStart();
            player.play().catch(() => { });
        }
    };

    const handleVideoEditPlay = () => setVideoEditPlaying(true);
    const handleVideoEditPause = () => setVideoEditPlaying(false);

    useEffect(() => {
        if (!videoEditDialogOpen) return;
        seekVideoToStart();
    }, [videoEditDialogOpen, videoEditData.startTime, seekVideoToStart]);

    const adjustInsertVideoTimings = useCallback(async (options = {}) => {
        const {
            source = 'clipboard',
            mappingData = null,
            skipAlreadyProcessed = false
        } = options || {};
        try {
            let parsed = mappingData;
            if (!parsed) {
                if (source === 'file') {
                    console.warn('[InsertVideoAdjust] mappingDataが提供されていません。');
                    return;
                }

                const clipboardText = await navigator.clipboard.readText();
                if (!clipboardText) {
                    alert('クリップボードにマッピングデータがありません');
                    return;
                }

                try {
                    parsed = JSON.parse(clipboardText);
                } catch (error) {
                    console.error('Failed to parse mapping JSON:', error);
                    alert('クリップボードのデータをJSONとして解析できませんでした');
                    return;
                }
            }

            const { updatedScriptItems, unmatchedItems } = adjustInsertVideoTimingsCore({
                scriptItems,
                mappingData: parsed,
                skipAlreadyProcessed,
                toleranceSeconds: INSERT_VIDEO_MATCH_TOLERANCE_SECONDS
            });

            pendingVideoAdjustResultRef.current = {
                updatedScriptItems,
                unmatchedItems
            };

            if (unmatchedItems.length) {
                setVideoAdjustConfirmOpen(true);
            } else {
                updateScriptItems(updatedScriptItems);
                alert('挿入動画の時間を更新しました');
            }
        } catch (error) {
            console.error('Failed to adjust insert video timings:', error);
            alert(`挿入動画の時間調整に失敗しました: ${error.message}`);
        }
    }, [scriptItems]);

    useEffect(() => {
        adjustInsertVideoTimingsRef.current = adjustInsertVideoTimings;
        return () => {
            adjustInsertVideoTimingsRef.current = null;
        };
    }, [adjustInsertVideoTimings]);

    // キューへの追加
    const handleAddToQueue = () => {
        if (autoUploadToYoutube && isYoutubeCredentialsAvailable && !selectedYoutubeToken) {
            setYoutubeTokenError(true);
            setYoutubeTokenDialogOpen(true);
            return;
        }

        if (!formData.script.text || !formData.script.speakerId || !formData.backgroundImage.text) {
            return;
        }

        // 1) チェック対象の ID 一覧を作成
        let idsToCheck = [];
        scriptItems.forEach((item) => {
            if (item.id) idsToCheck.push(item.id);
            if (item.speakerId) idsToCheck.push(item.speakerId);
        });
        idsToCheck = [...new Set(idsToCheck)];

        console.log(speakers)
        console.log(idsToCheck)

        // 2) 有効 ID 一覧を作成
        // 2) 有効 ID 一覧を作成
        const validIds = availableSpeakerIds;

        // 3) ステータス配列を生成
        const statuses = idsToCheck.map((id) => ({ id, valid: validIds.includes(id) }));
        const hasInvalid = statuses.some((s) => !s.valid);

        // 4) 無効 ID があればダイアログ表示 & キュー追加をキャンセル
        if (hasInvalid) {
            setUnknownIdStatuses(statuses);
            setUnknownIdsDialogOpen(true);
            return;
        }

        const baseDescription = formData.youtubeInfo.description || '';
        const appendFixed = fixedYoutubeDescription || '';
        const combinedDescription = appendFixed
            ? (baseDescription ? `${baseDescription}\n${appendFixed}` : appendFixed)
            : baseDescription;

        const queuePayload = {
            ...formData,
            youtubeInfo: {
                ...formData.youtubeInfo,
                description: combinedDescription
            },
            videoFormat
        };

        addToQueue(queuePayload);

        // フォームをリセット
        setFormData(initialFormState);
        setScriptItems([]);
        setYoutubeTokenError(false);
        setYoutubeTokenDialogOpen(false);
    };

    // クリップボードから画像URLまたはファイルパスをペーストする関数
    const handlePasteImageUrl = async (index) => {
        try {
            // 1. まず通常のクリップボードテキストを取得
            const text = await navigator.clipboard.readText();
            const trimmedText = text.trim();
            console.log('クリップボードテキスト:', trimmedText);

            // 画像形式のチェック
            if (!isAllowedImageFormat(trimmedText)) {
                setGifWarningMessage('サポートされていない画像形式です。PNG、JPG、JPEGファイルのみ使用できます。');
                setGifWarningDialogOpen(true);
                return;
            }

            // URLの場合はそのまま使用
            if (trimmedText.startsWith('http')) {
                // スクリプトアイテムの更新
                const updatedScriptItems = [...scriptItems];
                updatedScriptItems[index].img = trimmedText;

                // スクリプトアイテムとフォームデータを更新
                setScriptItems(updatedScriptItems);
                setFormData(prev => ({
                    ...prev,
                    script: {
                        ...prev.script,
                        text: JSON.stringify(updatedScriptItems)
                    }
                }));
                return;
            }

            // 完全なファイルパスの場合 - パスを直接保存
            if (trimmedText.startsWith('/') || trimmedText.startsWith('C:') || trimmedText.startsWith('c:')) {
                saveLocalPathToScript(trimmedText, index);
                return;
            }

            // 上記以外の場合、Electronのネイティブ機能でファイルパスを取得
            const clipboardResult = await window.electron.tts.getClipboardFilePath();
            console.log('Electronクリップボード結果:', clipboardResult);

            if (clipboardResult.success && clipboardResult.filePath) {
                const filePath = clipboardResult.filePath;

                // 画像形式のチェック
                if (!isAllowedImageFormat(filePath)) {
                    setGifWarningMessage('サポートされていない画像形式です。PNG、JPG、JPEGファイルのみ使用できます。');
                    setGifWarningDialogOpen(true);
                    return;
                }

                // ファイル名のみの場合（パス区切り文字を含まない場合）
                if (!filePath.includes('/') && !filePath.includes('\\')) {
                    // フォルダ選択ダイアログを表示してファイルを探す処理を追加することもできる
                    // とりあえずファイル名だけでも設定する
                    const updatedScriptItems = [...scriptItems];
                    updatedScriptItems[index].img = filePath;
                    updatedScriptItems[index].isFileNameOnly = true;

                    setScriptItems(updatedScriptItems);
                    setFormData(prev => ({
                        ...prev,
                        script: {
                            ...prev.script,
                            text: JSON.stringify(updatedScriptItems)
                        }
                    }));

                    alert(`ファイル名 "${filePath}" を設定しました。後でファイルを探す必要があります。`);
                    return;
                }

                // 完全なパスの場合はそのパスを直接保存
                saveLocalPathToScript(filePath, index);
                return;
            }

            // それでもファイルパスが取得できない場合
            alert('クリップボードにあるテキストはURLまたはファイルパスではありません。');
        } catch (error) {
            console.error('Failed to paste image URL:', error);
            alert(`クリップボードからの取得に失敗しました: ${error.message}`);
        }
    };

    // ローカルファイルパスをスクリプトに保存する関数
    const saveLocalPathToScript = (filePath, index) => {
        try {
            const fileExt = filePath.toLowerCase().split('.').pop();
            const isVideo = ALLOWED_VIDEO_EXTENSIONS.includes(fileExt);

            const updatedScriptItems = [...scriptItems];
            updatedScriptItems[index].img = filePath;

            if (isVideo) {
                updatedScriptItems[index].videoPath = filePath;
                updatedScriptItems[index].insert_video = filePath;

                const { startTime, endTime } = normalizeVideoTimes(
                    updatedScriptItems[index].startTime || '00:00:00',
                    updatedScriptItems[index].endTime || '00:00:01'
                );

                const startSeconds = parseTimeInput(startTime);
                const endSeconds = parseTimeInput(endTime);

                updatedScriptItems[index].startTime = startTime;
                updatedScriptItems[index].endTime = endTime;
                updatedScriptItems[index].videoStartOffset = startSeconds;
                updatedScriptItems[index].videoEndOffset = endSeconds;
                updatedScriptItems[index].duration = Math.max(1, endSeconds - startSeconds);
            } else {
                updatedScriptItems[index].localPath = filePath;
                delete updatedScriptItems[index].videoPath;
                delete updatedScriptItems[index].insert_video;
            }

            updateScriptItems(updatedScriptItems);
        } catch (error) {
            console.error('Failed to save local file path:', error);
            throw error;
        }
    };

    // 画像を削除する関数を追加
    const handleDeleteImage = (index) => {
        try {
            const updatedScriptItems = [...scriptItems];
            // imgプロパティを削除
            delete updatedScriptItems[index].img;

            // 動画関連のプロパティも削除
            if (updatedScriptItems[index].videoPath) {
                delete updatedScriptItems[index].videoPath;
            }
            if (updatedScriptItems[index].thumbnailPath) {
                delete updatedScriptItems[index].thumbnailPath;
            }
            if (updatedScriptItems[index].localPath) {
                delete updatedScriptItems[index].localPath;
            }

            // 生成中フラグやエラーフラグもクリア
            if (updatedScriptItems[index].isThumbnailGenerating) {
                delete updatedScriptItems[index].isThumbnailGenerating;
            }
            if (updatedScriptItems[index].thumbnailError) {
                delete updatedScriptItems[index].thumbnailError;
            }

            // スクリプトアイテムとフォームデータを更新
            setScriptItems(updatedScriptItems);
            setFormData(prev => ({
                ...prev,
                script: {
                    ...prev.script,
                    text: JSON.stringify(updatedScriptItems)
                }
            }));
        } catch (error) {
            console.error('Failed to delete image:', error);
        }
    };

    const handleOpenImageSearch = useCallback(async (imgValue, rowIndex) => {
        if (imgValue === null || imgValue === undefined) return;
        if (typeof rowIndex === 'number' && Number.isFinite(rowIndex)) {
            setLastOpenedImageSearchIndex(rowIndex);
        }
        const query = encodeURIComponent(String(imgValue));
        const url = `https://www.google.com/search?q=${query}&tbm=isch`;
        try {
            if (window?.electron && typeof window.electron.openExternal === 'function') {
                await window.electron.openExternal(url);
            } else {
                window.open(url, '_blank', 'noopener,noreferrer');
            }
        } catch (error) {
            console.error('ブラウザでURLを開けませんでした:', error);
            window.open(url, '_blank', 'noopener,noreferrer');
        }
    }, []);

    // 全ての画像にペーストする処理（クリップボードから）
    const handlePasteToAllImages = async () => {
        try {
            // 1. まず通常のクリップボードテキストを取得
            const text = await navigator.clipboard.readText();
            const trimmedText = text.trim();
            console.log('全体ペースト - クリップボードテキスト:', trimmedText);

            // 画像形式のチェック
            if (!isAllowedImageFormat(trimmedText)) {
                setGifWarningMessage('サポートされていない画像形式です。PNG、JPG、JPEGファイルのみ使用できます。');
                setGifWarningDialogOpen(true);
                return;
            }

            let imageUrl = null;

            // URLの場合はそのまま使用
            if (trimmedText.startsWith('http')) {
                imageUrl = trimmedText;
            } else if (trimmedText.startsWith('/') || trimmedText.startsWith('C:') || trimmedText.startsWith('c:')) {
                // 完全なファイルパスの場合
                imageUrl = trimmedText;
            } else {
                // Electronのネイティブ機能でファイルパスを取得
                const clipboardResult = await window.electron.tts.getClipboardFilePath();
                console.log('全体ペースト - Electronクリップボード結果:', clipboardResult);

                if (clipboardResult.success && clipboardResult.filePath) {
                    const filePath = clipboardResult.filePath;

                    // 画像形式のチェック
                    if (!isAllowedImageFormat(filePath)) {
                        setGifWarningMessage('サポートされていない画像形式です。PNG、JPG、JPEGファイルのみ使用できます。');
                        setGifWarningDialogOpen(true);
                        return;
                    }

                    imageUrl = filePath;
                } else {
                    alert('クリップボードにあるテキストはURLまたはファイルパスではありません。');
                    return;
                }
            }

            // 全てのスクリプトアイテムに適用
            if (imageUrl) {
                applyImageUrlToAllItems(imageUrl);
            }
        } catch (error) {
            console.error('全体ペースト処理エラー:', error);
            alert(`全体ペーストに失敗しました: ${error.message}`);
        }
    };

    // ファイルドロップ時の全体適用処理
    const handleFileUploadToAll = async (file) => {
        try {
            console.log('全体ファイルアップロード:', file.name, file.type);

            // 画像形式のチェック
            if (!isAllowedImageFormat(file.name, file.type)) {
                setGifWarningMessage('サポートされていない画像形式です。PNG、JPG、JPEGファイルのみ使用できます。');
                setGifWarningDialogOpen(true);
                return;
            }

            // ファイルタイプをチェック
            const isImage = file.type.startsWith('image/');
            const isVideo = file.type.startsWith('video/');

            if (!isImage && !isVideo) {
                alert('画像または動画ファイルのみアップロードできます');
                return;
            }

            // 一度だけファイルを保存
            const result = await window.electron.tts.saveUploadedFile(file);

            if (result.success) {
                const filePath = result.filePath;

                if (isVideo) {
                    // 動画の場合はサムネイルを生成してから全体に適用
                    try {
                        const thumbnailResult = await window.electron.tts.generateThumbnailFromVideo(filePath);
                        if (thumbnailResult.success) {
                            applyVideoToAllItems(filePath, thumbnailResult.thumbnailPath);
                        } else {
                            // サムネイル生成に失敗した場合でも動画パスは適用
                            applyVideoToAllItems(filePath, null);
                        }
                    } catch (thumbnailError) {
                        console.error('サムネイル生成エラー:', thumbnailError);
                        applyVideoToAllItems(filePath, null);
                    }
                } else {
                    // 画像の場合は直接適用
                    applyImageUrlToAllItems(filePath);
                }
            } else {
                throw new Error('ファイルの保存に失敗しました');
            }
        } catch (error) {
            console.error('全体ファイルアップロード処理エラー:', error);
            alert(`全体ファイルアップロードに失敗しました: ${error.message}`);
        }
    };

    // 画像URLを全てのスクリプトアイテムに適用する共通関数
    const applyImageUrlToAllItems = (imageUrl) => {
        const updatedScriptItems = scriptItems.map(item => ({
            ...item,
            img: imageUrl,
            localPath: imageUrl.startsWith('http') ? undefined : imageUrl,
            videoPath: undefined,
            insert_video: undefined,
            thumbnailPath: undefined,
            isThumbnailGenerating: undefined,
            thumbnailError: undefined
        }));

        updateScriptItems(updatedScriptItems);
    };

    // 動画を全てのスクリプトアイテムに適用する関数
    const applyVideoToAllItems = (videoPath, thumbnailPath) => {
        const updatedScriptItems = scriptItems.map(item => {
            const nextItem = { ...item };

            delete nextItem.insert_video;
            delete nextItem.insert_video_done;
            delete nextItem.startTime;
            delete nextItem.endTime;
            delete nextItem.start_time;
            delete nextItem.end_time;
            delete nextItem.videoStartOffset;
            delete nextItem.videoEndOffset;
            delete nextItem.duration;
            delete nextItem.path;

            nextItem.img = videoPath;
            nextItem.videoPath = videoPath;
            nextItem.localPath = undefined;
            nextItem.isThumbnailGenerating = false;

            if (thumbnailPath) {
                nextItem.thumbnailPath = thumbnailPath;
                nextItem.thumbnailError = false;
            } else {
                delete nextItem.thumbnailPath;
                nextItem.thumbnailError = true;
            }

            return nextItem;
        });

        skipScriptTextSyncRef.current = true;
        setScriptItems(updatedScriptItems);
        setFormData(prev => ({
            ...prev,
            script: {
                ...prev.script,
                text: JSON.stringify(updatedScriptItems)
            }
        }));
    };

    // ファイルアップロード処理
    const handleFileUpload = async (file, index) => {
        try {
            console.log('アップロードファイル:', file.name, file.type);

            // 画像形式のチェック
            if (!isAllowedImageFormat(file.name, file.type)) {
                setGifWarningMessage('サポートされていない画像形式です。PNG、JPG、JPEGファイルのみ使用できます。');
                setGifWarningDialogOpen(true);
                return;
            }

            // ファイルタイプをチェック
            const isImage = file.type.startsWith('image/');
            const isVideo = file.type.startsWith('video/');

            if (!isImage && !isVideo) {
                alert('画像または動画ファイルのみアップロードできます');
                return;
            }

            // ファイルをElectronに送信して一時保存
            const result = await window.electron.tts.saveUploadedFile(file);

            if (result.success) {
                // 保存されたファイルパスを取得
                const filePath = result.filePath;

                // スクリプトアイテムの更新（パスを直接保存）
                const updatedScriptItems = [...scriptItems];

                if (isVideo) {
                    // 動画ファイルの場合はサムネイルを生成
                    updatedScriptItems[index].videoPath = filePath;

                    // 処理中の表示を追加
                    updatedScriptItems[index].isThumbnailGenerating = true;
                    // 仮のimg値を設定
                    updatedScriptItems[index].img = filePath; // 動画パスも img に設定

                    // 更新してUIに生成中と表示
                    setScriptItems([...updatedScriptItems]);
                    setFormData(prev => ({
                        ...prev,
                        script: {
                            ...prev.script,
                            text: JSON.stringify(updatedScriptItems)
                        }
                    }));

                    // 非同期でサムネイル生成
                    try {
                        const thumbnailResult = await window.electron.tts.generateThumbnailFromVideo(filePath);
                        if (thumbnailResult.success) {
                            const thumbnailPath = thumbnailResult.thumbnailPath;

                            // サムネイルパスをスクリプトアイテムに追加
                            const latestScriptItems = [...scriptItems];
                            latestScriptItems[index].thumbnailPath = thumbnailPath;
                            latestScriptItems[index].videoPath = filePath; // 動画パスも保持
                            latestScriptItems[index].img = filePath; // imgにも動画パスを設定
                            latestScriptItems[index].isThumbnailGenerating = false;

                            // 更新
                            setScriptItems(latestScriptItems);
                            setFormData(prev => ({
                                ...prev,
                                script: {
                                    ...prev.script,
                                    text: JSON.stringify(latestScriptItems)
                                }
                            }));
                        } else {
                            throw new Error('サムネイル生成に失敗しました');
                        }
                    } catch (thumbnailError) {
                        console.error('サムネイル生成エラー:', thumbnailError);

                        // エラー状態を更新
                        const errorScriptItems = [...scriptItems];
                        errorScriptItems[index].isThumbnailGenerating = false;
                        errorScriptItems[index].thumbnailError = true;
                        // 動画パスは保持
                        errorScriptItems[index].videoPath = filePath;
                        errorScriptItems[index].img = filePath;
                        setScriptItems(errorScriptItems);
                        setFormData(prev => ({
                            ...prev,
                            script: {
                                ...prev.script,
                                text: JSON.stringify(errorScriptItems)
                            }
                        }));
                    }
                } else {
                    // 画像ファイルの場合は通常通り処理
                    updatedScriptItems[index].img = filePath;
                    updatedScriptItems[index].localPath = filePath;
                    // 画像の場合は動画パスをクリア
                    if (updatedScriptItems[index].videoPath) {
                        delete updatedScriptItems[index].videoPath;
                    }
                    if (updatedScriptItems[index].thumbnailPath) {
                        delete updatedScriptItems[index].thumbnailPath;
                    }

                    // スクリプトアイテムとフォームデータを更新
                    setScriptItems(updatedScriptItems);
                    setFormData(prev => ({
                        ...prev,
                        script: {
                            ...prev.script,
                            text: JSON.stringify(updatedScriptItems)
                        }
                    }));
                }
            } else {
                throw new Error('ファイルの保存に失敗しました');
            }
        } catch (error) {
            console.error('ファイルアップロード処理エラー:', error);
            alert(`ファイルのアップロードに失敗しました: ${error.message}`);
        }
    };

    // サムネイル設定用のハンドラー関数
    const handleThumbnailPaste = async (queueId) => {
        try {
            const text = await navigator.clipboard.readText();
            const trimmedText = text.trim();

            // 画像形式のチェック
            if (!isAllowedImageFormat(trimmedText)) {
                setGifWarningMessage('サポートされていない画像形式です。PNG、JPG、JPEGファイルのみ使用できます。');
                setGifWarningDialogOpen(true);
                return;
            }

            let thumbnailPath = null;

            // URLの場合はそのまま使用
            if (trimmedText.startsWith('http')) {
                thumbnailPath = trimmedText;
            } else if (trimmedText.startsWith('/') || trimmedText.startsWith('C:') || trimmedText.startsWith('c:')) {
                // 完全なファイルパスの場合
                thumbnailPath = trimmedText;
            } else {
                // Electronのネイティブ機能でファイルパスを取得
                const clipboardResult = await window.electron.tts.getClipboardFilePath();
                if (clipboardResult.success && clipboardResult.filePath) {
                    const filePath = clipboardResult.filePath;

                    // 画像形式のチェック
                    if (!isAllowedImageFormat(filePath)) {
                        setGifWarningMessage('サポートされていない画像形式です。PNG、JPG、JPEGファイルのみ使用できます。');
                        setGifWarningDialogOpen(true);
                        return;
                    }

                    thumbnailPath = filePath;
                } else {
                    alert('クリップボードにあるテキストはURLまたはファイルパスではありません。');
                    return;
                }
            }

            // キューアイテムを更新
            if (thumbnailPath) {
                updateQueueItem(queueId, {
                    youtubeInfo: {
                        thumbnailPath: thumbnailPath
                    }
                });
            }
        } catch (error) {
            console.error('Failed to paste thumbnail:', error);
            alert(`サムネイルの設定に失敗しました: ${error.message}`);
        }
    };

    const handleThumbnailFileUpload = async (file, queueId) => {
        try {
            // 画像形式のチェック
            if (!isAllowedImageFormat(file.name, file.type)) {
                setGifWarningMessage('サポートされていない画像形式です。PNG、JPG、JPEGファイルのみ使用できます。');
                setGifWarningDialogOpen(true);
                return;
            }

            // ファイルをElectronに送信して一時保存
            const result = await window.electron.tts.saveUploadedFile(file);

            if (result.success) {
                // キューアイテムを更新
                updateQueueItem(queueId, {
                    youtubeInfo: {
                        thumbnailPath: result.filePath
                    }
                });
            } else {
                throw new Error('ファイルの保存に失敗しました');
            }
        } catch (error) {
            console.error('サムネイルアップロード処理エラー:', error);
            alert(`サムネイルのアップロードに失敗しました: ${error.message}`);
        }
    };

    const handleThumbnailChangeImage = (queueId) => {
        setEditingImageIndex(queueId); // キューIDを使用
        const currentThumbnailPath = (queue || []).find((queueItem) => queueItem.id === queueId)?.youtubeInfo?.thumbnailPath || '';
        setSelectedImageUrl(currentThumbnailPath);
        setImageSelectionDialogOpen(true);
    };

    const handleThumbnailImageSelected = (imageUrl, queueId) => {
        // キューアイテムを更新
        updateQueueItem(queueId, {
            youtubeInfo: {
                thumbnailPath: imageUrl
            }
        });

        // ダイアログを閉じる
        setImageSelectionDialogOpen(false);
        setSelectedImageUrl('');
        setEditingImageIndex(-1);
    };

    const handleDeleteThumbnail = (queueId) => {
        updateQueueItem(queueId, {
            youtubeInfo: {
                thumbnailPath: null
            }
        });
    };

    const normalizedSpeakers = useMemo(() => speakers || [], [speakers]);
    const availableSpeakerIds = useMemo(() => {
        if (formData.script.language === 'en') {
            return englishSpeakers;
        }
        return normalizedSpeakers.flatMap((speaker) => (speaker?.styles || []).map((style) => style.id?.toString() ?? '').filter(Boolean));
    }, [normalizedSpeakers, englishSpeakers, formData.script.language]);
    const availableBgms = useMemo(() => bgmList || [], [bgmList]);

    useEffect(() => {
        if (!availableSpeakerIds.includes(formData.script.speakerId) && availableSpeakerIds.length > 0) {
            setFormData(prev => ({
                ...prev,
                script: {
                    ...prev.script,
                    speakerId: availableSpeakerIds[0]
                }
            }));
        }
    }, [availableSpeakerIds, formData.script.speakerId]);

    useEffect(() => {
        const bgmNames = availableBgms.map(item => item.fileName);
        // 「なし」はそのまま許可する
        if (!selectedBgm) return;
        if (!bgmNames.includes(selectedBgm)) {
            console.warn('選択中のBGMが見つからないため解除します:', selectedBgm);
            setSelectedBgm('');
            window.electron.tts.setBgm('').catch(() => { });
        }
    }, [availableBgms, selectedBgm, bgmVolume]);

    useEffect(() => {
        try {
            localStorage.setItem('tts-bgm-volume', bgmVolume.toString());
        } catch (_) {
            /* ignore */
        }
    }, [bgmVolume]);

    useEffect(() => {
        window.electron.tts.setBgmVolume(bgmVolume).catch(() => { });
    }, [bgmVolume]);

    useEffect(() => {
        try {
            localStorage.setItem('tts-captions-enabled', captionsEnabled ? 'true' : 'false');
        } catch (_) {
            /* ignore */
        }
        window.electron?.tts?.setCaptionsEnabled?.(!!captionsEnabled).catch(() => { });
    }, [captionsEnabled]);

    useEffect(() => {
        try {
            localStorage.setItem(VIDEO_FORMAT_STORAGE_KEY, videoFormat);
        } catch (_) {
            /* ignore */
        }
    }, [videoFormat]);

    useEffect(() => {
        const normalized = (typeof youtubeTokenFile === 'string') ? youtubeTokenFile.trim() : '';
        if (youtubeTokenFile !== undefined && normalized !== selectedYoutubeToken) {
            setSelectedYoutubeToken(normalized || '');
        }
    }, [youtubeTokenFile, selectedYoutubeToken]);

    useEffect(() => {
        if (youtubeTokenDialogOpen && selectedYoutubeToken) {
            setYoutubeTokenDialogOpen(false);
        }
    }, [youtubeTokenDialogOpen, selectedYoutubeToken]);

    return (
        <Box>
            {hasPresets && (
                <Dialog
                    open={presetDialogOpen}
                    onClose={handlePresetSkip}
                    maxWidth="sm"
                    fullWidth
                >
                    <DialogTitle>プリセットを選択</DialogTitle>
                    <DialogContent dividers>
                        <Stack spacing={2}>
                            <Typography variant="body2" color="text.secondary">
                                初期設定として適用するプリセットを選択してください。必要な場合は後から個別に調整できます。
                            </Typography>
                            <RadioGroup
                                value={selectedPresetId}
                                onChange={(event) => setSelectedPresetId(event.target.value)}
                            >
                                {presets.map((preset) => (
                                    <FormControlLabel
                                        key={preset.id || preset.name}
                                        value={preset.id}
                                        control={<Radio />}
                                        label={(
                                            <Box>
                                                <Typography variant="subtitle1" component="span">
                                                    {preset.name || preset.id}
                                                </Typography>
                                                <Typography variant="body2" color="text.secondary">
                                                    BGM: {preset.bgm || '-'}／イントロ: {preset.introBgVideo || '-'}／音量: {preset.bgmVolume ?? '-'}
                                                </Typography>
                                                {preset.fixedDescription && (
                                                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                                                        固定説明あり
                                                    </Typography>
                                                )}
                                            </Box>
                                        )}
                                    />
                                ))}
                            </RadioGroup>
                        </Stack>
                    </DialogContent>
                    <DialogActions>
                        <Button onClick={handlePresetSkip}>スキップ</Button>
                        <Button
                            variant="contained"
                            onClick={handlePresetDialogConfirm}
                            disabled={!selectedPresetId}
                        >
                            決定
                        </Button>
                    </DialogActions>
                </Dialog>
            )}

            {/* 不明 ID 警告ダイアログ */}
            <UnknownIdsDialog
                open={unknownIdsDialogOpen}
                onClose={() => setUnknownIdsDialogOpen(false)}
                idStatuses={unknownIdStatuses}
            />

            {/* 画像形式警告ダイアログ */}
            <Dialog
                open={gifWarningDialogOpen}
                onClose={() => setGifWarningDialogOpen(false)}
                aria-labelledby="image-format-warning-dialog-title"
                aria-describedby="image-format-warning-dialog-description"
            >
                <DialogTitle id="image-format-warning-dialog-title">
                    画像形式エラー
                </DialogTitle>
                <DialogContent>
                    <Typography id="image-format-warning-dialog-description">
                        {gifWarningMessage}
                    </Typography>
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setGifWarningDialogOpen(false)} autoFocus>
                        OK
                    </Button>
                </DialogActions>
            </Dialog>

            {/* YouTube認証ダイアログ */}
            <Dialog
                open={youtubeAuthDialogOpen && !isYoutubeAuthChecking && !isYoutubeAuthenticated}
                onClose={handleCloseYoutubeAuthDialog}
                maxWidth="md"
                fullWidth
            >
                <DialogTitle>YouTube認証が必要です</DialogTitle>
                <DialogContent>
                    <Stack spacing={3}>
                        <Typography>
                            YouTubeへの動画アップロードには認証が必要です。以下のリンクにアクセスして認証を行ってください。
                        </Typography>
                        <Link
                            href={youtubeAuthUrl || '#'}
                            onClick={handleOpenYoutubeAuthPage}
                            sx={{
                                pointerEvents: youtubeAuthProcessing ? 'none' : 'auto',
                                opacity: youtubeAuthProcessing ? 0.6 : 1
                            }}
                        >
                            認証ページを開く
                        </Link>
                        {youtubeAuthProcessing && (
                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                                <CircularProgress size={20} />
                                <Typography variant="body2">
                                    ブラウザで認証を完了してください。完了後、自動で反映されます。
                                </Typography>
                            </Box>
                        )}
                        {youtubeAuthErrorMessage && (
                            <Typography color="error.main" variant="body2">
                                {youtubeAuthErrorMessage}
                            </Typography>
                        )}
                    </Stack>
                </DialogContent>
                <DialogActions>
                    <Button
                        onClick={handleCloseYoutubeAuthDialog}
                    >
                        キャンセル
                    </Button>
                </DialogActions>
            </Dialog>

            {/* 画像選択ダイアログ */}
            <Dialog
                open={imageSelectionDialogOpen}
                onClose={() => {
                    setImageSelectionDialogOpen(false);
                    setSelectedImageUrl('');
                    setEditingImageIndex(-1);
                }}
                maxWidth="lg"
                fullWidth
            >
                <DialogTitle>
                    画像を選択
                    {scriptItems[editingImageIndex]?.text && (
                        <Typography variant="body2" color="text.secondary">
                            "{scriptItems[editingImageIndex].text.substring(0, 50)}..."
                        </Typography>
                    )}
                </DialogTitle>
                <DialogContent>
                    <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                        画像のURL（https://...）またはローカルファイルパス（/...）を入力して「選択」してください。
                    </Typography>

                    <Box sx={{ mb: 2 }}>
                        <TextField
                            fullWidth
                            label="画像URL / ファイルパス"
                            value={selectedImageUrl}
                            onChange={(e) => setSelectedImageUrl(e.target.value)}
                            size="small"
                        />
                    </Box>
                </DialogContent>
                <DialogActions>
                    <Button
                        onClick={() => {
                            setImageSelectionDialogOpen(false);
                            setSelectedImageUrl('');
                            setEditingImageIndex(-1);
                        }}
                    >
                        キャンセル
                    </Button>
                    <Button
                        onClick={() => handleImageSelected(selectedImageUrl)}
                        variant="contained"
                        disabled={!selectedImageUrl}
                    >
                        選択
                    </Button>
                </DialogActions>
            </Dialog>

            {/* 画像プレビューダイアログを動画対応に変更 */}
            <Dialog
                open={imagePreviewOpen}
                onClose={() => { setImagePreviewOpen(false); setPreviewIsVideo(false); setPreviewVideoPath(''); setPreviewImageUrl(''); }}
                maxWidth="xl"
                fullWidth
            >
                <DialogContent sx={{ p: 1, position: 'relative', textAlign: 'center' }}>
                    <Button onClick={() => setImagePreviewOpen(false)} sx={{ position: 'absolute', right: 8, top: 8, bgcolor: 'rgba(0,0,0,0.5)', color: 'white', '&:hover': { bgcolor: 'rgba(0,0,0,0.7)' } }}>
                        <Close />
                    </Button>
                    {previewIsVideo && previewVideoPath ? (
                        <Box sx={{ width: '100%', textAlign: 'center' }}>
                            <video src={resolveLocalPath(previewVideoPath)} controls autoPlay style={{ maxWidth: '100%', maxHeight: 'calc(100vh - 100px)' }} />
                        </Box>
                    ) : previewImageUrl && (
                        previewImageUrl.startsWith('local-image://') ? (
                            <LocalImagePreview filePath={decodeURIComponent(previewImageUrl.replace('local-image://', ''))} />
                        ) : (
                            <img src={previewImageUrl} alt="拡大画像" style={{ maxWidth: '100%', maxHeight: 'calc(100vh - 100px)', objectFit: 'contain' }} />
                        )
                    )}
                </DialogContent>
            </Dialog>

            <Stack spacing={3}>
                {/* 共通設定セクション */}
                <Paper sx={{ p: 2 }}>
                    <Typography variant="h6" gutterBottom>共通設定</Typography>
                    <Stack spacing={2}>
                        <Box>
                            <Typography gutterBottom>
                                再生速度: {playbackSpeed.toFixed(1)}倍速
                            </Typography>
                            <Slider
                                value={playbackSpeed}
                                onChange={(_, value) => setPlaybackSpeed(value)}
                                min={0.1}
                                max={2.0}
                                step={0.1}
                                marks={[
                                    { value: 1, label: '1x' },
                                    { value: 2, label: '2x' }
                                ]}
                            />
                        </Box>
                        <TextField
                            multiline
                            rows={4}
                            label="置換テキスト"
                            value={replacementText}
                            onChange={(e) => setReplacementText(e.target.value)}
                            placeholder="例：&#13;&#10;AGI=エージーアイ&#13;&#10;AI=エーアイ"
                        />

                        {/* Speaker 動画プレフィックス設定 */}
                        <TextField
                            label="スピーカー動画プレフィックス"
                            value={formData.speakerVideoPrefix}
                            onChange={(e) => {
                                const newValue = e.target.value;
                                setFormData(prev => ({ ...prev, speakerVideoPrefix: newValue }));
                                localStorage.setItem('speaker-video-prefix', newValue);
                            }}
                            helperText="スピーカー動画ファイル名の末尾に付与されます (例: _v)"
                        />

                        <FormControl fullWidth>
                            <InputLabel>イントロ背景動画</InputLabel>
                            <Select
                                label="イントロ背景動画"
                                value={selectedIntroBgVideo}
                                onChange={(e) => setSelectedIntroBgVideo(e.target.value)}
                                size="small"
                            >
                                {Array.from(
                                    new Set(['', selectedIntroBgVideo, ...introBgVideoOptions].filter((v) => v !== null && v !== undefined))
                                ).map((option) => (
                                    <MenuItem key={option || '__INTRO_NONE__'} value={option}>
                                        {option ? option : 'なし'}
                                    </MenuItem>
                                ))}
                            </Select>
                        </FormControl>

                        {/* BGM 選択（保存しない） */}
                        <FormControl fullWidth>
                            <InputLabel>BGM</InputLabel>
                            <Select
                                label="BGM"
                                value={selectedBgm}
                                onChange={async (e) => {
                                    const fileName = e.target.value;
                                    setSelectedBgm(fileName);
                                    if (!fileName) {
                                        try {
                                            await window.electron.tts.setBgm('');
                                        } catch (_) { /* ignore */ }
                                        return;
                                    }
                                    const item = bgmList.find(i => i.fileName === fileName);
                                    if (item && item.path) {
                                        try {
                                            await window.electron.tts.setBgm(item.path);
                                            await window.electron.tts.setBgmVolume(bgmVolume);
                                        } catch (_) { /* ignore */ }
                                    }
                                }}
                            >
                                <MenuItem value="">なし</MenuItem>
                                {bgmList.map(item => (
                                    <MenuItem key={item.path} value={item.fileName}>{item.fileName}</MenuItem>
                                ))}
                            </Select>
                        </FormControl>
                        <TextField
                            label="BGM音量"
                            type="number"
                            value={bgmVolume}
                            onChange={(e) => {
                                const value = parseFloat(e.target.value);
                                if (!Number.isNaN(value)) {
                                    setBgmVolume(Math.min(Math.max(value, 0), 1));
                                } else {
                                    setBgmVolume(0);
                                }
                            }}
                            inputProps={{ step: 0.1, min: 0, max: 1 }}
                            helperText="0〜1の範囲で設定してください"
                        />

                        {/* 字幕表示設定 */}
                        <FormControlLabel
                            control={
                                <Checkbox
                                    checked={!!captionsEnabled}
                                    onChange={(e) => setCaptionsEnabled(e.target.checked)}
                                    size="small"
                                />
                            }
                            label="字幕を表示"
                        />

                        {/* 動画形式（横長/ショート） */}
                        <FormControl component="fieldset">
                            <FormLabel component="legend">動画形式</FormLabel>
                            <RadioGroup
                                row
                                value={videoFormat}
                                onChange={(e) => setVideoFormat(normalizeVideoFormat(e.target.value))}
                            >
                                <FormControlLabel
                                    value={VIDEO_FORMATS.LANDSCAPE}
                                    control={<Radio size="small" />}
                                    label="横長（1920x1080）"
                                />
                                <FormControlLabel
                                    value={VIDEO_FORMATS.SHORT}
                                    control={<Radio size="small" />}
                                    label="ショート（1080x1920）"
                                />
                            </RadioGroup>
                        </FormControl>

                    </Stack>
                </Paper>

                {/* YouTube 設定セクション */}
                <Paper sx={{ p: 2 }}>
                    <Typography variant="h6" gutterBottom>YouTube設定</Typography>
                    <Stack spacing={2}>
                        {!isYoutubeCredentialsAvailable && (
                            <Typography color="error.main">
                                credentials.json が見つからないため、YouTube機能は無効です。
                            </Typography>
                        )}

                        <FormControlLabel
                            control={
                                <Checkbox
                                    checked={!!autoUploadToYoutube}
                                    onChange={(e) => setAutoUploadToYoutube(e.target.checked)}
                                    size="small"
                                    disabled={youtubeControlsDisabled}
                                />
                            }
                            label="YouTubeに自動アップロード"
                        />

                        <FormControl
                            fullWidth
                            error={youtubeTokenError || !isYoutubeTokenCustomValid}
                            disabled={youtubeTokenSelectDisabled}
                            onClick={() => {
                                if (!selectedYoutubeToken && autoUploadToYoutube && isYoutubeCredentialsAvailable) {
                                    setYoutubeTokenDialogOpen(true);
                                }
                            }}
                        >
                            <InputLabel error={youtubeTokenError || !isYoutubeTokenCustomValid}>YouTubeトークン</InputLabel>
                            <Select
                                label="YouTubeトークン"
                                value={youtubeTokenSelectValue}
                                onChange={handleYoutubeTokenSelectChange}
                                size="small"
                                disabled={youtubeTokenSelectDisabled}
                            >
                                {youtubeTokenOptions.map(option => (
                                    <MenuItem key={option.value || '__YOUTUBE_TOKEN_EMPTY__'} value={option.value}>
                                        {option.label}
                                    </MenuItem>
                                ))}
                            </Select>
                            {!autoUploadToYoutube && (
                                <FormHelperText>自動アップロードをONにすると選択できます。</FormHelperText>
                            )}
                            {autoUploadToYoutube && !isYoutubeCredentialsAvailable && (
                                <FormHelperText>credentials.json がないため選択できません。</FormHelperText>
                            )}
                        </FormControl>

                        {youtubeTokenSelectValue === YOUTUBE_TOKEN_CUSTOM_VALUE && (
                            <TextField
                                label="新規トークンファイル名"
                                value={youtubeTokenCustomName}
                                onChange={handleYoutubeTokenCustomChange}
                                onBlur={handleYoutubeTokenCustomBlur}
                                size="small"
                                error={!isYoutubeTokenCustomValid}
                                helperText={isYoutubeTokenCustomValid ? '拡張子 .json を指定してください。' : '.json のファイル名を入力してください。'}
                                disabled={youtubeTokenSelectDisabled}
                            />
                        )}

                        {/* YouTube認証状態表示 */}
                        <Box sx={{ mt: 1 }}>
                            <Typography variant="subtitle1">YouTube認証状態</Typography>
                            {youtubeControlsDisabled ? (
                                <Typography color="text.secondary">
                                    credentials.json がないため認証できません。
                                </Typography>
                            ) : !autoUploadToYoutube ? (
                                <Typography color="text.secondary">
                                    自動アップロードがOFFのため認証は不要です。
                                </Typography>
                            ) : isYoutubeAuthChecking ? (
                                <Box sx={{ display: 'flex', alignItems: 'center' }}>
                                    <CircularProgress size={20} sx={{ mr: 1 }} />
                                    <Typography>認証状態を確認中...</Typography>
                                </Box>
                            ) : isYoutubeAuthenticated ? (
                                <Typography color="success.main">認証済み</Typography>
                            ) : (
                                <Box>
                                    <Typography color="error.main">未認証</Typography>
                                    <Button
                                        variant="outlined"
                                        size="small"
                                        onClick={() => {
                                            if (!selectedYoutubeToken) {
                                                setYoutubeTokenDialogOpen(true);
                                                return;
                                            }
                                            setYoutubeAuthErrorMessage('');
                                            setYoutubeAuthProcessing(false);
                                            setYoutubeAuthUrl('');
                                            setYoutubeAuthDialogOpen(true);
                                        }}
                                        sx={{ mt: 1 }}
                                        disabled={youtubeTokenSelectDisabled || !selectedYoutubeToken || !isYoutubeTokenCustomValid}
                                    >
                                        認証する
                                    </Button>
                                </Box>
                            )}
                        </Box>
                    </Stack>
                </Paper>

                {/* 新規キュー追加フォーム */}
                <Paper sx={{ p: 2 }}>
                    <Typography variant="h6" gutterBottom>新規キュー追加</Typography>

                    {/* JSONペーストボタンを追加 */}
                    <Box sx={{ display: 'flex', alignItems: 'center', mb: 2 }}>
                        <Button
                            variant="outlined"
                            onClick={handleJsonPaste}
                            disabled={isLoadingImagesFromJson}
                            sx={{ mr: 1 }}
                        >
                            JSONをペースト
                        </Button>
                        <Button
                            variant="outlined"
                            color="primary"
                            onClick={adjustInsertVideoTimings}
                            sx={{ mr: 1 }}
                        >
                            Insert動画時間調整
                        </Button>
                        {isLoadingImagesFromJson && (
                            <Box sx={{ display: 'flex', alignItems: 'center' }}>
                                <CircularProgress size={24} sx={{ mr: 1 }} />
                                <Typography variant="body2" color="text.secondary">
                                    画像読み込み中...
                                </Typography>
                            </Box>
                        )}
                    </Box>

                    <Stack spacing={2}>
                        {/* スクリプト設定セクション */}
                        <Paper sx={{ p: 2 }}>
                            <Typography variant="subtitle1" gutterBottom>スクリプト設定</Typography>
                            <Stack spacing={2}>
                                <FormControl fullWidth>
                                    <InputLabel>話者を選択</InputLabel>
                                    <Select
                                        value={formData.script.speakerId}
                                        onChange={handleFormChange('script', 'speakerId')}
                                        label="話者を選択"
                                    >
                                        {formData.script.language === 'en' ? (
                                            englishSpeakers.map((speakerId) => (
                                                <MenuItem key={speakerId} value={speakerId}>
                                                    {speakerId}
                                                </MenuItem>
                                            ))
                                        ) : (
                                            speakers.map((speaker) => (
                                                speaker.styles.map((style) => (
                                                    <MenuItem key={style.id} value={style.id}>
                                                        {`${speaker.name} - ${style.name}`}
                                                    </MenuItem>
                                                ))
                                            ))
                                        )}
                                    </Select>
                                </FormControl>
                                <FormControl component="fieldset">
                                    <FormLabel component="legend">読み上げ言語</FormLabel>
                                    <RadioGroup
                                        row
                                        value={formData.script.language}
                                        onChange={handleFormChange('script', 'language')}
                                    >
                                        {LANGUAGE_OPTIONS.map((option) => (
                                            <FormControlLabel
                                                key={option.value}
                                                value={option.value}
                                                control={<Radio size="small" />}
                                                label={option.label}
                                            />
                                        ))}
                                    </RadioGroup>
                                </FormControl>
                                <TextField
                                    multiline
                                    rows={4}
                                    label="読み上げるテキスト"
                                    value={formData.script.text}
                                    onChange={handleFormChange('script', 'text')}
                                />
                            </Stack>
                        </Paper>

                        {/* スクリプト画像設定セクション */}
                        {scriptItems.length > 0 && (
                            <Paper sx={{ p: 2 }}>
                                <Typography variant="subtitle1" gutterBottom>スクリプト画像設定</Typography>
                                <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                                    insert_video エントリは挿入動画として扱われ、ここからドラッグ＆ドロップで差し替えや時間編集が可能です。
                                </Typography>

                                {/* 全体ペーストボタン */}
                                <Box sx={{ mb: 2 }}>
                                    <Button
                                        variant="outlined"
                                        color="primary"
                                        onClick={handlePasteToAllImages}
                                        onDragOver={(e) => {
                                            e.preventDefault();
                                            e.stopPropagation();
                                        }}
                                        onDragLeave={(e) => {
                                            e.preventDefault();
                                            e.stopPropagation();
                                        }}
                                        onDrop={(e) => {
                                            e.preventDefault();
                                            e.stopPropagation();

                                            if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                                                const file = e.dataTransfer.files[0];
                                                handleFileUploadToAll(file);
                                            }
                                        }}
                                        sx={{
                                            fontSize: '0.875rem',
                                            borderStyle: 'dashed',
                                            '&:hover': {
                                                backgroundColor: 'rgba(0, 0, 0, 0.05)',
                                            }
                                        }}
                                    >
                                        📋 全ての画像にペースト / ドロップ
                                    </Button>
                                </Box>

                                <TableContainer component={Paper} variant="outlined">
                                    <Table size="small">
                                        <TableHead>
                                            <TableRow>
                                                <TableCell width="35%">テキスト</TableCell>
                                                <TableCell width="15%">画像キーワード</TableCell>
                                                <TableCell width="25%">プレビュー</TableCell>
                                                <TableCell width="25%">操作</TableCell>
                                            </TableRow>
                                        </TableHead>
                                        <TableBody>
                                            {scriptItems.map((item, index) => {
                                                if (item.isSection) {
                                                    return (
                                                        <TableRow key={index}>
                                                            <TableCell colSpan={4}>
                                                                <Box sx={{
                                                                    bgcolor: 'black',
                                                                    color: 'white',
                                                                    p: 1,
                                                                    textAlign: 'center',
                                                                    borderRadius: 1
                                                                }}>
                                                                    <Typography variant="subtitle1" fontWeight="bold">
                                                                        {item.section}
                                                                    </Typography>
                                                                </Box>
                                                            </TableCell>
                                                        </TableRow>
                                                    );
                                                }

                                                const isImageUrl = item.img && typeof item.img === 'string' && item.img.startsWith('http');
                                                const isInsertVideo = !!item.insert_video;
                                                const videoStart = isInsertVideo ? item.startTime : null;
                                                const videoEnd = isInsertVideo ? item.endTime : null;

                                                return (
                                                    <TableRow key={index} sx={isInsertVideo ? { bgcolor: 'action.hover' } : undefined}>
                                                        <TableCell>
                                                            <Tooltip title={item.text} arrow placement="top">
                                                                <Typography
                                                                    variant="body2"
                                                                    sx={{
                                                                        maxHeight: '80px',
                                                                        overflow: 'hidden',
                                                                        textOverflow: 'ellipsis',
                                                                        display: '-webkit-box',
                                                                        WebkitLineClamp: 3,
                                                                        WebkitBoxOrient: 'vertical'
                                                                    }}
                                                                >
                                                                    {item.text}
                                                                </Typography>
                                                            </Tooltip>
                                                        </TableCell>
                                                        <TableCell>
                                                            <Stack spacing={0.5}>
                                                                {isInsertVideo && (
                                                                    <Typography variant="caption" color="primary" sx={{ fontWeight: 600 }}>
                                                                        insert_video
                                                                    </Typography>
                                                                )}
                                                                <Typography variant="body2" color="text.secondary">
                                                                    {isInsertVideo ? `Start: ${videoStart}` : (item.originalKeyword || '未設定')}
                                                                </Typography>
                                                                <Typography variant="body2" color="text.secondary">
                                                                    {isInsertVideo ? `End: ${videoEnd}` : (isImageUrl || (item.img && !item.img.startsWith('http')) ? '設定済み' : item.img || '未設定')}
                                                                </Typography>
                                                            </Stack>
                                                        </TableCell>
                                                        <TableCell>
                                                            {isImageUrl ? (
                                                                <Box
                                                                    component="img"
                                                                    src={item.img}
                                                                    alt="設定済み画像"
                                                                    sx={{
                                                                        height: '50px',
                                                                        maxWidth: '100%',
                                                                        objectFit: 'cover',
                                                                        borderRadius: '4px',
                                                                        cursor: 'pointer',
                                                                        '&:hover': {
                                                                            opacity: 0.8,
                                                                        }
                                                                    }}
                                                                    onClick={() => {
                                                                        setPreviewIsVideo(false);
                                                                        setPreviewImageUrl(item.img);
                                                                        setPreviewVideoPath('');
                                                                        setImagePreviewOpen(true);
                                                                    }}
                                                                />
                                                            ) : item.img && (item.img.startsWith('/') || item.img.startsWith('C:') || item.img.startsWith('c:')) ? (
                                                                // ローカルファイルパスの場合
                                                                <Box sx={{ position: 'relative' }}>
                                                                    <Box
                                                                        component="img"
                                                                        src={`local-image://${encodeURIComponent(item.thumbnailPath || item.img)}`}
                                                                        alt="ローカル画像"
                                                                        sx={{
                                                                            height: '50px',
                                                                            maxWidth: '100%',
                                                                            objectFit: 'cover',
                                                                            borderRadius: '4px',
                                                                            cursor: 'pointer',
                                                                            '&:hover': {
                                                                                opacity: 0.8,
                                                                            }
                                                                        }}
                                                                        onClick={() => {
                                                                            // 動画ファイルの拡張子をチェック
                                                                            const fileExt = item.img.toLowerCase().split('.').pop();
                                                                            const videoExts = ['mp4', 'mov', 'avi', 'mkv', 'wmv', 'flv', 'webm'];

                                                                            if (item.videoPath || videoExts.includes(fileExt)) {
                                                                                // 動画ファイルの場合
                                                                                setPreviewIsVideo(true);
                                                                                setPreviewVideoPath(item.videoPath || item.img);
                                                                                setPreviewImageUrl('');
                                                                            } else {
                                                                                // 画像ファイルの場合
                                                                                setPreviewIsVideo(false);
                                                                                setPreviewImageUrl(`local-image://${encodeURIComponent(item.img)}`);
                                                                                setPreviewVideoPath('');
                                                                            }
                                                                            setImagePreviewOpen(true);
                                                                        }}
                                                                        onError={(e) => {
                                                                            console.error('ローカル画像の読み込みエラー:', item.img);
                                                                            e.target.src = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"%3E%3Ccircle cx="12" cy="12" r="10"%3E%3C/circle%3E%3Cline x1="15" y1="9" x2="9" y2="15"%3E%3C/line%3E%3Cline x1="9" y1="9" x2="15" y2="15"%3E%3C/line%3E%3C/svg%3E';
                                                                            e.target.alt = 'イメージ読み込みエラー';
                                                                            e.target.style.opacity = '0.5';
                                                                        }}
                                                                    />

                                                                    {/* 動画ファイルの場合は再生アイコンを表示 */}
                                                                    {(item.videoPath || item.img.toLowerCase().match(/\.(mp4|mov|avi|mkv|wmv|flv|webm)$/)) && (
                                                                        <Box sx={{
                                                                            position: 'absolute',
                                                                            top: '50%',
                                                                            left: '50%',
                                                                            transform: 'translate(-50%, -50%)',
                                                                            bgcolor: 'rgba(0,0,0,0.5)',
                                                                            borderRadius: '50%',
                                                                            width: '24px',
                                                                            height: '24px',
                                                                            display: 'flex',
                                                                            alignItems: 'center',
                                                                            justifyContent: 'center',
                                                                            pointerEvents: 'none'
                                                                        }}>
                                                                            <Box
                                                                                component="svg"
                                                                                width="12"
                                                                                height="12"
                                                                                viewBox="0 0 24 24"
                                                                                fill="white"
                                                                            >
                                                                                <path d="M8 5v14l11-7z" />
                                                                            </Box>
                                                                        </Box>
                                                                    )}
                                                                </Box>
                                                            ) : item.isThumbnailGenerating ? (
                                                                // サムネイル生成中の場合
                                                                <Box sx={{
                                                                    display: 'flex',
                                                                    flexDirection: 'column',
                                                                    alignItems: 'center',
                                                                    justifyContent: 'center',
                                                                    height: '50px',
                                                                    width: '100%'
                                                                }}>
                                                                    <CircularProgress size={24} sx={{ mb: 0.5 }} />
                                                                    <Typography variant="caption">
                                                                        サムネイル生成中...
                                                                    </Typography>
                                                                </Box>
                                                            ) : item.thumbnailError ? (
                                                                // サムネイル生成エラーの場合
                                                                <Box sx={{
                                                                    display: 'flex',
                                                                    flexDirection: 'column',
                                                                    alignItems: 'center',
                                                                    justifyContent: 'center',
                                                                    height: '50px'
                                                                }}>
                                                                    <Typography variant="caption" color="error">
                                                                        サムネイル生成エラー
                                                                    </Typography>
                                                                    <Typography variant="caption">
                                                                        {item.videoPath ? '動画ファイル: ' + path.basename(item.videoPath) : ''}
                                                                    </Typography>
                                                                </Box>
                                                            ) : item.videoPath && item.thumbnailPath ? (
                                                                // 動画のサムネイルがある場合
                                                                <Box sx={{ position: 'relative' }}>
                                                                    <Box
                                                                        component="img"
                                                                        src={item.thumbnailPath ?
                                                                            `local-image://${encodeURIComponent(item.thumbnailPath)}` :
                                                                            'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"%3E%3Ccircle cx="12" cy="12" r="10"%3E%3C/circle%3E%3Cline x1="15" y1="9" x2="9" y2="15"%3E%3C/line%3E%3Cline x1="9" y1="9" x2="15" y2="15"%3E%3C/line%3E%3C/svg%3E'
                                                                        }
                                                                        alt="動画サムネイル"
                                                                        style={{
                                                                            height: '50px',
                                                                            maxWidth: '100%',
                                                                            objectFit: 'cover',
                                                                            borderRadius: '4px',
                                                                            cursor: 'pointer',
                                                                            '&:hover': {
                                                                                opacity: 0.8,
                                                                            }
                                                                        }}
                                                                        onClick={() => {
                                                                            setPreviewIsVideo(true);
                                                                            setPreviewVideoPath(item.videoPath);
                                                                            setPreviewImageUrl('');
                                                                            setImagePreviewOpen(true);
                                                                        }}
                                                                        onError={(e) => {
                                                                            console.error('サムネイル画像の読み込みエラー:', item.thumbnailPath);
                                                                            e.target.src = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"%3E%3Ccircle cx="12" cy="12" r="10"%3E%3C/circle%3E%3Cline x1="15" y1="9" x2="9" y2="15"%3E%3C/line%3E%3Cline x1="9" y1="9" x2="15" y2="15"%3E%3C/line%3E%3C/svg%3E';
                                                                            e.target.alt = 'サムネイル読み込みエラー';
                                                                            e.target.style.opacity = '0.5';
                                                                        }}
                                                                    />
                                                                    {/* 動画アイコンをオーバーレイ表示 */}
                                                                    <Box sx={{
                                                                        position: 'absolute',
                                                                        top: '50%',
                                                                        left: '50%',
                                                                        transform: 'translate(-50%, -50%)',
                                                                        bgcolor: 'rgba(0,0,0,0.5)',
                                                                        borderRadius: '50%',
                                                                        width: '24px',
                                                                        height: '24px',
                                                                        display: 'flex',
                                                                        alignItems: 'center',
                                                                        justifyContent: 'center',
                                                                        pointerEvents: 'none'
                                                                    }}>
                                                                        <Box
                                                                            component="svg"
                                                                            width="12"
                                                                            height="12"
                                                                            viewBox="0 0 24 24"
                                                                            fill="white"
                                                                        >
                                                                            <path d="M8 5v14l11-7z" />
                                                                        </Box>
                                                                    </Box>
                                                                </Box>
                                                            ) : (
                                                                <Typography variant="body2" color="text.secondary">
                                                                    プレビューなし
                                                                </Typography>
                                                            )}
                                                        </TableCell>
                                                        <TableCell>
                                                            <Box
                                                                onDragOver={(e) => {
                                                                    if (isInsertVideo) {
                                                                        e.preventDefault();
                                                                        e.stopPropagation();
                                                                        setVideoDragOver(index);
                                                                    }
                                                                }}
                                                                onDragLeave={(e) => {
                                                                    if (isInsertVideo) {
                                                                        e.preventDefault();
                                                                        e.stopPropagation();
                                                                        setVideoDragOver(-1);
                                                                    }
                                                                }}
                                                                onDrop={(e) => {
                                                                    if (isInsertVideo) {
                                                                        e.preventDefault();
                                                                        e.stopPropagation();
                                                                        setVideoDragOver(-1);
                                                                        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                                                                            const file = e.dataTransfer.files[0];
                                                                            handleVideoDropReplace(index, file);
                                                                        }
                                                                    }
                                                                }}
                                                                sx={{
                                                                    p: 1,
                                                                    borderRadius: 1,
                                                                    border: videoDragOver === index ? '2px dashed' : 'none',
                                                                    borderColor: 'primary.main',
                                                                    transition: 'border 0.15s ease-in-out'
                                                                }}
                                                            >
                                                                {isImageUrl ? (
                                                                    <Box
                                                                        component="img"
                                                                        src={item.img}
                                                                        alt="設定済み画像"
                                                                        sx={{
                                                                            height: '50px',
                                                                            maxWidth: '100%',
                                                                            objectFit: 'cover',
                                                                            borderRadius: '4px',
                                                                            cursor: 'pointer',
                                                                            '&:hover': {
                                                                                opacity: 0.8,
                                                                            }
                                                                        }}
                                                                        onClick={() => {
                                                                            setPreviewIsVideo(false);
                                                                            setPreviewImageUrl(item.img);
                                                                            setPreviewVideoPath('');
                                                                            setImagePreviewOpen(true);
                                                                        }}
                                                                    />
                                                                ) : item.img && (item.img.startsWith('/') || item.img.startsWith('C:') || item.img.startsWith('c:')) ? (
                                                                    // ローカルファイルパスの場合
                                                                    <Box sx={{ position: 'relative' }}>
                                                                        <Box
                                                                            component="img"
                                                                            src={`local-image://${encodeURIComponent(item.thumbnailPath || item.img)}`}
                                                                            alt="ローカル画像"
                                                                            sx={{
                                                                                height: '50px',
                                                                                maxWidth: '100%',
                                                                                objectFit: 'cover',
                                                                                borderRadius: '4px',
                                                                                cursor: 'pointer',
                                                                                '&:hover': {
                                                                                    opacity: 0.8,
                                                                                }
                                                                            }}
                                                                            onClick={() => {
                                                                                // 動画ファイルの拡張子をチェック
                                                                                const fileExt = item.img.toLowerCase().split('.').pop();
                                                                                const videoExts = ['mp4', 'mov', 'avi', 'mkv', 'wmv', 'flv', 'webm'];

                                                                                if (item.videoPath || videoExts.includes(fileExt)) {
                                                                                    // 動画ファイルの場合
                                                                                    setPreviewIsVideo(true);
                                                                                    setPreviewVideoPath(item.videoPath || item.img);
                                                                                    setPreviewImageUrl('');
                                                                                } else {
                                                                                    // 画像ファイルの場合
                                                                                    setPreviewIsVideo(false);
                                                                                    setPreviewImageUrl(`local-image://${encodeURIComponent(item.img)}`);
                                                                                    setPreviewVideoPath('');
                                                                                }
                                                                                setImagePreviewOpen(true);
                                                                            }}
                                                                            onError={(e) => {
                                                                                console.error('ローカル画像の読み込みエラー:', item.img);
                                                                                e.target.src = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"%3E%3Ccircle cx="12" cy="12" r="10"%3E%3C/circle%3E%3Cline x1="15" y1="9" x2="9" y2="15"%3E%3C/line%3E%3Cline x1="9" y1="9" x2="15" y2="15"%3E%3C/line%3E%3C/svg%3E';
                                                                                e.target.alt = 'イメージ読み込みエラー';
                                                                                e.target.style.opacity = '0.5';
                                                                            }}
                                                                        />

                                                                        {/* 動画ファイルの場合は再生アイコンを表示 */}
                                                                        {(item.videoPath || item.img.toLowerCase().match(/\.(mp4|mov|avi|mkv|wmv|flv|webm)$/)) && (
                                                                            <Box sx={{
                                                                                position: 'absolute',
                                                                                top: '50%',
                                                                                left: '50%',
                                                                                transform: 'translate(-50%, -50%)',
                                                                                bgcolor: 'rgba(0,0,0,0.5)',
                                                                                borderRadius: '50%',
                                                                                width: '24px',
                                                                                height: '24px',
                                                                                display: 'flex',
                                                                                alignItems: 'center',
                                                                                justifyContent: 'center',
                                                                                pointerEvents: 'none'
                                                                            }}>
                                                                                <Box
                                                                                    component="svg"
                                                                                    width="12"
                                                                                    height="12"
                                                                                    viewBox="0 0 24 24"
                                                                                    fill="white"
                                                                                >
                                                                                    <path d="M8 5v14l11-7z" />
                                                                                </Box>
                                                                            </Box>
                                                                        )}
                                                                    </Box>
                                                                ) : item.isThumbnailGenerating ? (
                                                                    // サムネイル生成中の場合
                                                                    <Box sx={{
                                                                        display: 'flex',
                                                                        flexDirection: 'column',
                                                                        alignItems: 'center',
                                                                        justifyContent: 'center',
                                                                        height: '50px',
                                                                        width: '100%'
                                                                    }}>
                                                                        <CircularProgress size={24} sx={{ mb: 0.5 }} />
                                                                        <Typography variant="caption">
                                                                            サムネイル生成中...
                                                                        </Typography>
                                                                    </Box>
                                                                ) : item.thumbnailError ? (
                                                                    // サムネイル生成エラーの場合
                                                                    <Box sx={{
                                                                        display: 'flex',
                                                                        flexDirection: 'column',
                                                                        alignItems: 'center',
                                                                        justifyContent: 'center',
                                                                        height: '50px'
                                                                    }}>
                                                                        <Typography variant="caption" color="error">
                                                                            サムネイル生成エラー
                                                                        </Typography>
                                                                        <Typography variant="caption">
                                                                            {item.videoPath ? '動画ファイル: ' + path.basename(item.videoPath) : ''}
                                                                        </Typography>
                                                                    </Box>
                                                                ) : item.videoPath && item.thumbnailPath ? (
                                                                    // 動画のサムネイルがある場合
                                                                    <Box sx={{ position: 'relative' }}>
                                                                        <Box
                                                                            component="img"
                                                                            src={item.thumbnailPath ?
                                                                                `local-image://${encodeURIComponent(item.thumbnailPath)}` :
                                                                                'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"%3E%3Ccircle cx="12" cy="12" r="10"%3E%3C/circle%3E%3Cline x1="15" y1="9" x2="9" y2="15"%3E%3C/line%3E%3Cline x1="9" y1="9" x2="15" y2="15"%3E%3C/line%3E%3C/svg%3E'
                                                                            }
                                                                            alt="動画サムネイル"
                                                                            style={{
                                                                                height: '50px',
                                                                                maxWidth: '100%',
                                                                                objectFit: 'cover',
                                                                                borderRadius: '4px',
                                                                                cursor: 'pointer',
                                                                                '&:hover': {
                                                                                    opacity: 0.8,
                                                                                }
                                                                            }}
                                                                            onClick={() => {
                                                                                setPreviewIsVideo(true);
                                                                                setPreviewVideoPath(item.videoPath);
                                                                                setPreviewImageUrl('');
                                                                                setImagePreviewOpen(true);
                                                                            }}
                                                                            onError={(e) => {
                                                                                console.error('サムネイル画像の読み込みエラー:', item.thumbnailPath);
                                                                                e.target.src = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"%3E%3Ccircle cx="12" cy="12" r="10"%3E%3C/circle%3E%3Cline x1="15" y1="9" x2="9" y2="15"%3E%3C/line%3E%3Cline x1="9" y1="9" x2="15" y2="15"%3E%3C/line%3E%3C/svg%3E';
                                                                                e.target.alt = 'サムネイル読み込みエラー';
                                                                                e.target.style.opacity = '0.5';
                                                                            }}
                                                                        />
                                                                        {/* 動画アイコンをオーバーレイ表示 */}
                                                                        <Box sx={{
                                                                            position: 'absolute',
                                                                            top: '50%',
                                                                            left: '50%',
                                                                            transform: 'translate(-50%, -50%)',
                                                                            bgcolor: 'rgba(0,0,0,0.5)',
                                                                            borderRadius: '50%',
                                                                            width: '24px',
                                                                            height: '24px',
                                                                            display: 'flex',
                                                                            alignItems: 'center',
                                                                            justifyContent: 'center',
                                                                            pointerEvents: 'none'
                                                                        }}>
                                                                            <Box
                                                                                component="svg"
                                                                                width="12"
                                                                                height="12"
                                                                                viewBox="0 0 24 24"
                                                                                fill="white"
                                                                            >
                                                                                <path d="M8 5v14l11-7z" />
                                                                            </Box>
                                                                        </Box>
                                                                    </Box>
                                                                ) : (
                                                                    <Typography variant="body2" color="text.secondary">
                                                                        プレビューなし
                                                                    </Typography>
                                                                )}
                                                            </Box>
                                                        </TableCell>
                                                        <TableCell>
                                                            <Stack direction="row" spacing={0.5}>
                                                                <Button
                                                                    size="small"
                                                                    variant="outlined"
                                                                    onClick={() => handleChangeImage(index)}
                                                                    sx={{ minWidth: '60px', fontSize: '0.75rem', py: 0.5 }}
                                                                >
                                                                    変更
                                                                </Button>
                                                                <Button
                                                                    size="small"
                                                                    variant="outlined"
                                                                    color="secondary"
                                                                    onClick={() => handlePasteImageUrl(index)}
                                                                    onDragOver={(e) => {
                                                                        e.preventDefault();
                                                                        e.stopPropagation();
                                                                        setDragOver(index);
                                                                    }}
                                                                    onDragLeave={(e) => {
                                                                        e.preventDefault();
                                                                        e.stopPropagation();
                                                                        setDragOver(-1);
                                                                    }}
                                                                    onDrop={(e) => {
                                                                        e.preventDefault();
                                                                        e.stopPropagation();
                                                                        setDragOver(-1);

                                                                        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                                                                            const file = e.dataTransfer.files[0];
                                                                            handleFileUpload(file, index);
                                                                        }
                                                                    }}
                                                                    sx={{
                                                                        minWidth: '60px',
                                                                        fontSize: '0.75rem',
                                                                        py: 0.5,
                                                                        borderStyle: dragOver === index ? 'dashed' : 'solid',
                                                                        backgroundColor: dragOver === index ? 'rgba(0, 0, 0, 0.05)' : 'transparent',
                                                                    }}
                                                                >
                                                                    ペースト
                                                                </Button>
                                                                {String(item.img || '').trim() && (
                                                                    <Tooltip title="ブラウザで開く（Google画像検索）" arrow>
                                                                        <IconButton
                                                                            size="small"
                                                                            aria-label="ブラウザで開く"
                                                                            onClick={() => handleOpenImageSearch(item.img, index)}
                                                                            sx={{
                                                                                bgcolor: lastOpenedImageSearchIndex === index ? 'action.selected' : 'transparent',
                                                                                borderRadius: 1,
                                                                                '&:hover': {
                                                                                    bgcolor: lastOpenedImageSearchIndex === index ? 'action.selected' : 'action.hover',
                                                                                },
                                                                            }}
                                                                        >
                                                                            <OpenInNew fontSize="small" />
                                                                        </IconButton>
                                                                    </Tooltip>
                                                                )}
                                                                {isInsertVideo && (
                                                                    <Button
                                                                        size="small"
                                                                        variant="outlined"
                                                                        color="primary"
                                                                        onClick={() => handleVideoEditDialogOpen(index)}
                                                                        sx={{ minWidth: '60px', fontSize: '0.75rem', py: 0.5 }}
                                                                    >
                                                                        編集
                                                                    </Button>
                                                                )}
                                                                <Button
                                                                    size="small"
                                                                    variant="outlined"
                                                                    color="error"
                                                                    onClick={() => handleDeleteImage(index)}
                                                                    sx={{ minWidth: '60px', fontSize: '0.75rem', py: 0.5 }}
                                                                >
                                                                    削除
                                                                </Button>
                                                            </Stack>
                                                        </TableCell>
                                                    </TableRow>
                                                );
                                            })}
                                        </TableBody>
                                    </Table>
                                </TableContainer>
                            </Paper>
                        )}

                        {/* YouTube設定セクション */}
                        <Paper sx={{ p: 2 }}>
                            <Typography variant="subtitle1" gutterBottom>YouTube設定</Typography>
                            <Stack spacing={2}>
                                <TextField
                                    label="タイトル"
                                    value={formData.youtubeInfo.title}
                                    onChange={handleFormChange('youtubeInfo', 'title')}
                                />
                                <TextField
                                    multiline
                                    rows={3}
                                    label="説明"
                                    value={formData.youtubeInfo.description}
                                    onChange={handleFormChange('youtubeInfo', 'description')}
                                />
                                <TextField
                                    multiline
                                    rows={3}
                                    label="説明（固定）"
                                    value={fixedYoutubeDescription}
                                    onChange={(e) => setFixedYoutubeDescription(e.target.value)}
                                    helperText="説明の下部に自動的に追加されます"
                                />
                                <TextField
                                    label="タグ（カンマ区切り）"
                                    value={formData.youtubeInfo.tags}
                                    onChange={handleFormChange('youtubeInfo', 'tags')}
                                />
                                <FormControl fullWidth>
                                    <InputLabel>カテゴリー</InputLabel>
                                    <Select
                                        value={formData.youtubeInfo.categoryId}
                                        onChange={handleFormChange('youtubeInfo', 'categoryId')}
                                        label="カテゴリー"
                                    >
                                        <MenuItem value="1">映画とアニメ</MenuItem>
                                        <MenuItem value="2">自動車と乗り物</MenuItem>
                                        <MenuItem value="10">音楽</MenuItem>
                                        <MenuItem value="15">ペットと動物</MenuItem>
                                        <MenuItem value="17">スポーツ</MenuItem>
                                        <MenuItem value="19">旅行とイベント</MenuItem>
                                        <MenuItem value="20">ゲーム</MenuItem>
                                        <MenuItem value="22">ブログ</MenuItem>
                                        <MenuItem value="23">コメディー</MenuItem>
                                        <MenuItem value="24">エンターテイメント</MenuItem>
                                        <MenuItem value="25">ニュースと政治</MenuItem>
                                        <MenuItem value="26">ハウツーとスタイル</MenuItem>
                                        <MenuItem value="27">教育</MenuItem>
                                        <MenuItem value="28">科学と技術</MenuItem>
                                        <MenuItem value="29">非営利団体と社会活動</MenuItem>
                                    </Select>
                                </FormControl>
                            </Stack>
                        </Paper>

                        {/* 背景画像設定セクション */}
                        <Paper sx={{ p: 2 }}>
                            <Typography variant="subtitle1" gutterBottom>背景画像テキスト設定</Typography>
                            <Stack spacing={2}>
                                <TextField
                                    multiline
                                    rows={4}
                                    label="背景画像に表示するテキスト"
                                    value={formData.backgroundImage?.text || ''}
                                    onChange={(e) => setFormData(prev => ({
                                        ...prev,
                                        backgroundImage: {
                                            text: e.target.value
                                        }
                                    }))}
                                    placeholder="例：&#13;&#10;タイトル&#13;&#10;サブタイトル&#13;&#10;説明文"
                                />
                            </Stack>
                        </Paper>

                        <Button
                            variant="contained"
                            onClick={handleAddToQueue}
                            startIcon={<Add />}
                            disabled={!formData.script.text || !formData.script.speakerId || !formData.backgroundImage.text}
                        >
                            キューに追加
                        </Button>
                    </Stack>
                </Paper>

                {/* キューリスト */}
                <Paper sx={{ p: 2 }}>
                    <Stack
                        direction="row"
                        justifyContent="space-between"
                        alignItems="center"
                        sx={{ mb: 2 }}
                    >
                        <Typography variant="h6">キューリスト</Typography>
                        <Box>
                            <Button
                                variant="contained"
                                color="primary"
                                onClick={startProcessing}
                                disabled={isProcessing || queue.length === 0}
                                startIcon={<PlayArrow />}
                                sx={{ mr: 1 }}
                            >
                                開始
                            </Button>
                            <Button
                                variant="contained"
                                color="error"
                                onClick={stopProcessing}
                                disabled={!isProcessing}
                                startIcon={<Stop />}
                            >
                                停止
                            </Button>
                        </Box>
                    </Stack>
                    <Stack spacing={1}>
                        {queue.map((item, index) => (
                            <Accordion
                                key={item.id}
                                sx={{
                                    bgcolor: index === currentQueueIndex ? 'action.selected' : 'background.paper'
                                }}
                            >
                                <AccordionSummary expandIcon={<ExpandMore />}>
                                    <Stack
                                        direction="row"
                                        justifyContent="space-between"
                                        alignItems="center"
                                        spacing={2}
                                        sx={{ width: '100%' }}
                                    >
                                        <Typography variant="subtitle1">
                                            {item.youtubeInfo.title || '無題'}
                                        </Typography>
                                        <Typography variant="body2" color="text.secondary">
                                            状態: {item.status}
                                        </Typography>
                                    </Stack>
                                </AccordionSummary>
                                <AccordionDetails>
                                    <Stack spacing={2}>
                                        {/* スクリプト情報 */}
                                        <Box>
                                            <Typography variant="subtitle2" gutterBottom>スクリプト</Typography>
                                            <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>
                                                {item.script.text}
                                            </Typography>
                                        </Box>

                                        {/* YouTube情報 */}
                                        <Box>
                                            <Typography variant="subtitle2" gutterBottom>YouTube設定</Typography>
                                            <Typography variant="body2">タイトル: {item.youtubeInfo.title}</Typography>
                                            <Typography variant="body2">説明: {item.youtubeInfo.description}</Typography>
                                            <Typography variant="body2">タグ: {item.youtubeInfo.tags}</Typography>
                                        </Box>

                                        {/* YouTubeサムネイル設定 */}
                                        <Box>
                                            <Typography variant="subtitle2" gutterBottom>YouTubeサムネイル</Typography>
                                            {item.youtubeInfo.thumbnailPath ? (
                                                <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                                                    <Box
                                                        component="img"
                                                        src={
                                                            item.youtubeInfo.thumbnailPath.startsWith('http')
                                                                ? item.youtubeInfo.thumbnailPath
                                                                : `local-image://${encodeURIComponent(item.youtubeInfo.thumbnailPath)}`
                                                        }
                                                        alt="YouTubeサムネイル"
                                                        sx={{
                                                            height: '80px',
                                                            maxWidth: '120px',
                                                            objectFit: 'cover',
                                                            borderRadius: '4px',
                                                            cursor: 'pointer',
                                                            '&:hover': {
                                                                opacity: 0.8,
                                                            }
                                                        }}
                                                        onClick={() => {
                                                            setPreviewIsVideo(false);
                                                            setPreviewImageUrl(
                                                                item.youtubeInfo.thumbnailPath.startsWith('http')
                                                                    ? item.youtubeInfo.thumbnailPath
                                                                    : resolveLocalPath(item.youtubeInfo.thumbnailPath)
                                                            );
                                                            setPreviewVideoPath('');
                                                            setImagePreviewOpen(true);
                                                        }}
                                                        onError={(e) => {
                                                            console.error('サムネイル画像の読み込みエラー:', item.youtubeInfo.thumbnailPath);
                                                            e.target.src = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"%3E%3Ccircle cx="12" cy="12" r="10"%3E%3C/circle%3E%3Cline x1="15" y1="9" x2="9" y2="15"%3E%3C/line%3E%3Cline x1="9" y1="9" x2="15" y2="15"%3E%3C/line%3E%3C/svg%3E';
                                                            e.target.alt = 'サムネイル読み込みエラー';
                                                            e.target.style.opacity = '0.5';
                                                        }}
                                                    />
                                                    <Stack direction="column" spacing={0.5}>
                                                        <Button
                                                            size="small"
                                                            variant="outlined"
                                                            onClick={() => handleThumbnailChangeImage(item.id)}
                                                            sx={{ minWidth: '80px', fontSize: '0.75rem' }}
                                                        >
                                                            変更
                                                        </Button>
                                                        <Button
                                                            size="small"
                                                            variant="outlined"
                                                            color="secondary"
                                                            onClick={() => handleThumbnailPaste(item.id)}
                                                            onDragOver={(e) => {
                                                                e.preventDefault();
                                                                e.stopPropagation();
                                                            }}
                                                            onDragLeave={(e) => {
                                                                e.preventDefault();
                                                                e.stopPropagation();
                                                            }}
                                                            onDrop={(e) => {
                                                                e.preventDefault();
                                                                e.stopPropagation();

                                                                if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                                                                    const file = e.dataTransfer.files[0];
                                                                    handleThumbnailFileUpload(file, item.id);
                                                                }
                                                            }}
                                                            sx={{ minWidth: '80px', fontSize: '0.75rem' }}
                                                        >
                                                            ペースト
                                                        </Button>
                                                        <Button
                                                            size="small"
                                                            variant="outlined"
                                                            color="error"
                                                            onClick={() => handleDeleteThumbnail(item.id)}
                                                            sx={{ minWidth: '80px', fontSize: '0.75rem' }}
                                                        >
                                                            削除
                                                        </Button>
                                                    </Stack>
                                                </Box>
                                            ) : (
                                                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                                                    <Typography variant="body2" color="text.secondary">
                                                        サムネイルが設定されていません
                                                    </Typography>
                                                    <Stack direction="row" spacing={0.5}>
                                                        <Button
                                                            size="small"
                                                            variant="outlined"
                                                            onClick={() => handleThumbnailChangeImage(item.id)}
                                                            sx={{ minWidth: '60px', fontSize: '0.75rem' }}
                                                        >
                                                            選択
                                                        </Button>
                                                        <Button
                                                            size="small"
                                                            variant="outlined"
                                                            color="secondary"
                                                            onClick={() => handleThumbnailPaste(item.id)}
                                                            onDragOver={(e) => {
                                                                e.preventDefault();
                                                                e.stopPropagation();
                                                            }}
                                                            onDragLeave={(e) => {
                                                                e.preventDefault();
                                                                e.stopPropagation();
                                                            }}
                                                            onDrop={(e) => {
                                                                e.preventDefault();
                                                                e.stopPropagation();

                                                                if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                                                                    const file = e.dataTransfer.files[0];
                                                                    handleThumbnailFileUpload(file, item.id);
                                                                }
                                                            }}
                                                            sx={{ minWidth: '60px', fontSize: '0.75rem' }}
                                                        >
                                                            ペースト
                                                        </Button>
                                                    </Stack>
                                                </Box>
                                            )}
                                        </Box>

                                        {/* 背景画像 */}
                                        {item.backgroundImage && (
                                            <Box>
                                                <Typography variant="subtitle2" gutterBottom>背景画像</Typography>
                                                <Box
                                                    sx={{
                                                        position: 'relative',
                                                        maxWidth: '100%',
                                                        maxHeight: 150,
                                                        cursor: 'pointer',
                                                        '&:hover': {
                                                            opacity: 0.8,
                                                        }
                                                    }}
                                                    onClick={() => {
                                                        if (item.backgroundImage?.videoPath) {
                                                            setPreviewIsVideo(true);
                                                            setPreviewVideoPath(item.backgroundImage.videoPath);
                                                            setPreviewImageUrl('');
                                                        } else {
                                                            setPreviewIsVideo(false);
                                                            const imgSrc = typeof item.backgroundImage === 'string' &&
                                                                (item.backgroundImage.startsWith('/') || item.backgroundImage.startsWith('C:')) ?
                                                                resolveLocalPath(item.backgroundImage) :
                                                                (item.backgroundImage.base64 || '');
                                                            setPreviewImageUrl(imgSrc);
                                                            setPreviewVideoPath('');
                                                        }
                                                        setImagePreviewOpen(true);
                                                    }}
                                                >
                                                    {item.backgroundImage?.videoPath ? (
                                                        <>
                                                            <img
                                                                src={item.backgroundImage?.thumbnailPath ?
                                                                    `local-image://${encodeURIComponent(item.backgroundImage.thumbnailPath)}` :
                                                                    'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"%3E%3Ccircle cx="12" cy="12" r="10"%3E%3C/circle%3E%3Cline x1="15" y1="9" x2="9" y2="15"%3E%3C/line%3E%3Cline x1="9" y1="9" x2="15" y2="15"%3E%3C/line%3E%3C/svg%3E'
                                                                }
                                                                alt="動画サムネイル"
                                                                style={{
                                                                    maxWidth: '100%',
                                                                    maxHeight: 150,
                                                                    objectFit: 'contain'
                                                                }}
                                                            />
                                                            <Box sx={{
                                                                position: 'absolute',
                                                                top: '50%',
                                                                left: '50%',
                                                                transform: 'translate(-50%, -50%)',
                                                                bgcolor: 'rgba(0,0,0,0.5)',
                                                                borderRadius: '50%',
                                                                width: '40px',
                                                                height: '40px',
                                                                display: 'flex',
                                                                alignItems: 'center',
                                                                justifyContent: 'center'
                                                            }}>
                                                                <Box
                                                                    component="svg"
                                                                    width="20"
                                                                    height="20"
                                                                    viewBox="0 0 24 24"
                                                                    fill="white"
                                                                >
                                                                    <path d="M8 5v14l11-7z" />
                                                                </Box>
                                                            </Box>
                                                        </>
                                                    ) : (
                                                        <img
                                                            src={
                                                                typeof item.backgroundImage === 'string' && (item.backgroundImage.startsWith('/') || item.backgroundImage.startsWith('C:'))
                                                                    ? `local-image://${encodeURIComponent(item.backgroundImage)}`
                                                                    : (item.backgroundImage.base64 || '')
                                                            }
                                                            alt="背景画像"
                                                            style={{
                                                                maxWidth: '100%',
                                                                maxHeight: 150,
                                                                objectFit: 'contain'
                                                            }}
                                                            onError={(e) => {
                                                                console.error('背景画像の読み込みエラー:',
                                                                    typeof item.backgroundImage === 'string' ? item.backgroundImage : 'base64画像');
                                                                e.target.src = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"%3E%3Ccircle cx="12" cy="12" r="10"%3E%3C/circle%3E%3Cline x1="15" y1="9" x2="9" y2="15"%3E%3C/line%3E%3Cline x1="9" y1="9" x2="15" y2="15"%3E%3C/line%3E%3C/svg%3E';
                                                                e.target.alt = 'イメージ読み込みエラー';
                                                                e.target.style.opacity = '0.5';
                                                            }}
                                                        />
                                                    )}
                                                </Box>
                                            </Box>
                                        )}

                                        {/* 進捗状況 */}
                                        {item.status === 'processing' && (
                                            <Box>
                                                <Typography variant="subtitle2" gutterBottom>進捗状況</Typography>
                                                <Typography variant="body2">
                                                    生成: {(item.progress.generating * 100).toFixed(1)}%
                                                </Typography>
                                                <Typography variant="body2">
                                                    動画: {(item.progress.video * 100).toFixed(1)}%
                                                </Typography>
                                                <Typography
                                                    variant="body2"
                                                    sx={{ color: autoUploadToYoutube ? 'text.primary' : 'text.disabled' }}
                                                >
                                                    アップロード: {(item.progress.upload * 100).toFixed(1)}%
                                                </Typography>
                                            </Box>
                                        )}

                                        {/* 削除ボタン - isProcessingに関係なく表示 */}
                                        <Button
                                            variant="outlined"
                                            color="error"
                                            onClick={() => removeFromQueue(item.id)}
                                            size="small"
                                        >
                                            削除
                                        </Button>
                                    </Stack>
                                </AccordionDetails>
                            </Accordion>
                        ))}
                    </Stack>
                </Paper>
                {/* 画面下の固定バーに被らないよう、処理中のみ下に余白を確保 */}
                {isProcessing && <Box sx={{ height: 140 }} />}
            </Stack>

            <PodCastProgressBar />

            <Dialog
                open={videoEditDialogOpen}
                onClose={handleVideoEditDialogClose}
                maxWidth="md"
                fullWidth
            >
                <DialogTitle>挿入動画の時間を編集</DialogTitle>
                <DialogContent>
                    <Stack spacing={2}>
                        <video
                            ref={videoPlayerRef}
                            src={resolvedVideoEditPath || undefined}
                            controls
                            style={{ width: '100%', borderRadius: 8 }}
                            onLoadedMetadata={handleVideoEditLoaded}
                            onTimeUpdate={handleVideoEditTimeUpdate}
                            onPlay={handleVideoEditPlay}
                            onPause={handleVideoEditPause}
                        />
                        <Stack direction="row" spacing={1} alignItems="center">
                            <Button variant="outlined" onClick={() => adjustVideoEditTime('startTime', -1)}>-1s</Button>
                            <TextField
                                label="開始時間"
                                value={videoEditData.startTime}
                                onChange={(e) => handleVideoEditTimeChange('startTime', e.target.value)}
                                size="small"
                                sx={{ minWidth: 180 }}
                            />
                            <Button variant="outlined" onClick={() => adjustVideoEditTime('startTime', 1)}>+1s</Button>
                        </Stack>
                        <Stack direction="row" spacing={1} alignItems="center">
                            <Button variant="outlined" onClick={() => adjustVideoEditTime('endTime', -1)}>-1s</Button>
                            <TextField
                                label="終了時間"
                                value={videoEditData.endTime}
                                onChange={(e) => handleVideoEditTimeChange('endTime', e.target.value)}
                                size="small"
                                sx={{ minWidth: 180 }}
                            />
                            <Button variant="outlined" onClick={() => adjustVideoEditTime('endTime', 1)}>+1s</Button>
                        </Stack>
                        <Stack direction="row" spacing={1}>
                            <Button variant="contained" onClick={handleVideoEditPlayToggle}>
                                {videoEditPlaying ? '一時停止' : '再生'}
                            </Button>
                            <Button variant="outlined" onClick={() => {
                                if (!videoPlayerRef.current) return;
                                videoPlayerRef.current.currentTime = parseTimeInput(videoEditData.startTime);
                            }}>
                                先頭に戻る
                            </Button>
                        </Stack>
                    </Stack>
                </DialogContent>
                <DialogActions>
                    <Button onClick={handleVideoEditDialogClose}>キャンセル</Button>
                    <Button variant="contained" onClick={applyVideoEditChanges}>適用</Button>
                </DialogActions>
            </Dialog>

            <InsertVideoAdjustConfirmDialog
                open={videoAdjustConfirmOpen}
                unmatchedItems={pendingVideoAdjustResultRef.current?.unmatchedItems || []}
                onCancel={() => {
                    pendingVideoAdjustResultRef.current = null;
                    setVideoAdjustConfirmOpen(false);
                }}
                onConfirm={() => {
                    if (pendingVideoAdjustResultRef.current) {
                        updateScriptItems(pendingVideoAdjustResultRef.current.updatedScriptItems);
                    }
                    pendingVideoAdjustResultRef.current = null;
                    setVideoAdjustConfirmOpen(false);
                    alert('挿入動画の時間を更新しました');
                }}
            />

            {/* YouTubeトークン未選択警告ダイアログ */}
            <Dialog
                open={youtubeTokenDialogOpen}
                onClose={() => setYoutubeTokenDialogOpen(false)}
                aria-labelledby="youtube-token-dialog-title"
            >
                <DialogTitle id="youtube-token-dialog-title">YouTubeトークンが未選択です</DialogTitle>
                <DialogContent dividers>
                    <Typography>
                        キューに追加する前に使用するYouTubeトークンを選択してください。
                    </Typography>
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setYoutubeTokenDialogOpen(false)} autoFocus>
                        OK
                    </Button>
                </DialogActions>
            </Dialog>
        </Box>
    );
};

module.exports = PodCastCreator; 
