const React = require('react');
const { useEffect, useMemo, useState } = require('react');
const {
  Box,
  Paper,
  Typography,
  TextField,
  Stack,
  IconButton,
  CircularProgress,
  Divider,
  Chip,
} = require('@mui/material');
const {
  PlayArrow,
  Stop,
  ContentCopy,
} = require('@mui/icons-material');

const SpeakerListView = () => {
  const [speakers, setSpeakers] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [sampleText, setSampleText] = useState(() => {
    try {
      return localStorage.getItem('speaker-preview-text') || 'こんにちは。これは話者プレビューです。';
    } catch (_) {
      return 'こんにちは。これは話者プレビューです。';
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem('speaker-preview-text', sampleText);
    } catch (_) {
      /* ignore */
    }
  }, [sampleText]);

  useEffect(() => {
    const loadSpeakers = async () => {
      setIsLoading(true);
      setError('');
      try {
        const list = await window.electron.tts.getSpeakers();
        setSpeakers(Array.isArray(list) ? list : []);
      } catch (e) {
        console.error('話者リストの取得に失敗しました:', e);
        setError('話者リストの取得に失敗しました');
      } finally {
        setIsLoading(false);
      }
    };

    loadSpeakers();
  }, []);

  const filteredSpeakers = useMemo(() => {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return speakers;

    return (speakers || [])
      .map((speaker) => {
        const styles = (speaker?.styles || []).filter((style) => {
          const haystack = [
            speaker?.name,
            style?.name,
            style?.id,
          ]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();
          return haystack.includes(q);
        });
        return { ...speaker, styles };
      })
      .filter((speaker) => (speaker?.styles || []).length > 0);
  }, [speakers, query]);

  const stopPreview = async () => {
    try {
      await window.electron.tts.stopAudio();
    } catch (e) {
      console.error('停止に失敗しました:', e);
    }
  };

  const playPreview = async (styleId) => {
    const id = String(styleId || '').trim();
    if (!id) return;

    const text = String(sampleText || '').trim() || 'こんにちは。これは話者プレビューです。';
    try {
      // 前の再生が残っていると重なることがあるので先に停止
      await stopPreview();
      await window.electron.tts.playAudio(
        [{ text, id }],
        0,
        1.0,
        false,
        { language: 'ja' }
      );
    } catch (e) {
      console.error('プレビュー再生に失敗しました:', e);
    }
  };

  const copyToClipboard = async (value) => {
    try {
      await navigator.clipboard.writeText(String(value));
    } catch (e) {
      console.error('クリップボードへのコピーに失敗しました:', e);
    }
  };

  return (
    <Box>
      <Paper sx={{ p: 3 }}>
        <Stack spacing={2}>
          <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={2}>
            <Typography variant="h5" component="h2">
              話者一覧
            </Typography>
            <IconButton onClick={stopPreview} title="停止">
              <Stop />
            </IconButton>
          </Stack>

          <TextField
            label="検索（話者名 / スタイル名 / ID）"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            fullWidth
          />

          <TextField
            label="プレビューテキスト"
            value={sampleText}
            onChange={(e) => setSampleText(e.target.value)}
            fullWidth
          />

          {isLoading && (
            <Stack direction="row" spacing={1} alignItems="center">
              <CircularProgress size={20} />
              <Typography variant="body2">読み込み中...</Typography>
            </Stack>
          )}

          {!isLoading && error && (
            <Typography variant="body2" color="error">
              {error}
            </Typography>
          )}

          {!isLoading && !error && filteredSpeakers.length === 0 && (
            <Typography variant="body2" color="text.secondary">
              話者が見つかりませんでした。
            </Typography>
          )}

          {!isLoading && !error && filteredSpeakers.map((speaker) => (
            <Box key={speaker?.uuid || speaker?.name}>
              <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }}>
                <Typography variant="h6">{speaker?.name || 'Unknown'}</Typography>
                {Array.isArray(speaker?.styles) && (
                  <Chip size="small" label={`${speaker.styles.length} styles`} />
                )}
              </Stack>

              {(speaker?.styles || []).map((style) => (
                <Stack
                  key={style?.id}
                  direction="row"
                  spacing={1}
                  alignItems="center"
                  sx={{ py: 0.5 }}
                >
                  <IconButton
                    onClick={() => playPreview(style?.id)}
                    title="プレビュー再生"
                    size="small"
                  >
                    <PlayArrow />
                  </IconButton>
                  <IconButton
                    onClick={() => copyToClipboard(style?.id)}
                    title="IDをコピー"
                    size="small"
                  >
                    <ContentCopy fontSize="inherit" />
                  </IconButton>
                  <Typography variant="body2" sx={{ flex: 1 }}>
                    {`${style?.name || 'Unknown'} (${style?.id || '-'})`}
                  </Typography>
                </Stack>
              ))}

              <Divider sx={{ my: 2 }} />
            </Box>
          ))}
        </Stack>
      </Paper>
    </Box>
  );
};

module.exports = SpeakerListView;


