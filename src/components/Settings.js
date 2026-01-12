const React = require('react');
const { useCallback, useEffect, useState } = require('react');
const { Box, Button, Stack, TextField, Typography, Alert } = require('@mui/material');

const Settings = () => {
  const [workDir, setWorkDir] = useState('');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');

  const loadWorkDir = useCallback(async () => {
    setError('');
    setInfo('');
    try {
      const result = await window.electron?.settings?.getWorkDir?.();
      const dir = (typeof result?.workDir === 'string') ? result.workDir : '';
      setWorkDir(dir);
    } catch (e) {
      setError(e?.message || '作業ディレクトリの取得に失敗しました');
      setWorkDir('');
    }
  }, []);

  useEffect(() => {
    loadWorkDir();
  }, [loadWorkDir]);

  const handleOpenWorkDir = useCallback(async () => {
    setError('');
    setInfo('');
    try {
      const result = await window.electron?.settings?.openWorkDir?.();
      if (result?.success) return;
      setError(result?.error || '作業ディレクトリを開けませんでした');
    } catch (e) {
      setError(e?.message || '作業ディレクトリを開けませんでした');
    }
  }, []);

  const handleChangeWorkDir = useCallback(async () => {
    setError('');
    setInfo('');
    try {
      const result = await window.electron?.settings?.selectWorkDir?.();
      if (result?.success && typeof result.workDir === 'string') {
        setWorkDir(result.workDir);
        setInfo('作業ディレクトリを変更しました。反映のため「再読み込み」してください。');
        return;
      }
      if (result?.cancelled) return;
      setError(result?.error || '作業ディレクトリの変更に失敗しました');
    } catch (e) {
      setError(e?.message || '作業ディレクトリの変更に失敗しました');
    }
  }, []);

  const handleReload = useCallback(() => {
    window.location.reload();
  }, []);

  return (
    <Box sx={{ maxWidth: 900 }}>
      <Typography variant="h5" sx={{ mb: 2 }}>
        設定
      </Typography>

      <Typography variant="body2" sx={{ mb: 2, color: 'text.secondary' }}>
        作業ディレクトリは、BGM/背景動画/プリセット/YouTubeトークン等の保存・参照先です。
      </Typography>

      {error ? (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      ) : null}

      {info ? (
        <Alert severity="success" sx={{ mb: 2 }}>
          {info}
        </Alert>
      ) : null}

      <Stack spacing={2}>
        <TextField
          label="作業ディレクトリ"
          value={workDir || ''}
          fullWidth
          InputProps={{ readOnly: true }}
        />

        <Stack direction="row" spacing={1}>
          <Button variant="contained" onClick={handleOpenWorkDir} disabled={!workDir}>
            Finderで開く
          </Button>
          <Button variant="outlined" onClick={handleChangeWorkDir}>
            変更...
          </Button>
          <Button variant="text" onClick={handleReload}>
            再読み込み
          </Button>
        </Stack>
      </Stack>
    </Box>
  );
};

module.exports = Settings;

