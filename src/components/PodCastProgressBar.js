const React = require('react');
const { useMemo } = require('react');
const { Box, Paper, Typography, LinearProgress, Stack, IconButton, Tooltip, CircularProgress } = require('@mui/material');
const { Stop } = require('@mui/icons-material');
const { usePodCast } = require('../contexts/PodCastContext');

const clamp01 = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
};

const PodCastProgressBar = () => {
  const {
    queue,
    isProcessing,
    currentQueueIndex,
    stopProcessing,
    autoUploadToYoutube,
    currentProgressStage
  } = usePodCast();

  const currentItem = useMemo(() => {
    if (!Array.isArray(queue)) return null;
    if (typeof currentQueueIndex !== 'number') return null;
    if (currentQueueIndex < 0 || currentQueueIndex >= queue.length) return null;
    return queue[currentQueueIndex] || null;
  }, [queue, currentQueueIndex]);

  const progress = currentItem?.progress || {};
  const generating = clamp01(progress.generating);
  const video = clamp01(progress.video);
  const upload = clamp01(progress.upload);
  const uploadDisabled = !autoUploadToYoutube;
  const activeStage = isProcessing && currentItem?.status === 'processing' ? currentProgressStage : null;

  const hasAnyProgress = generating > 0 || video > 0 || upload > 0;
  if (!isProcessing && !hasAnyProgress) {
    return null;
  }

  const title = currentItem?.youtubeInfo?.title || '処理中...';
  const indexLabel = Array.isArray(queue) && currentQueueIndex >= 0
    ? `${currentQueueIndex + 1}/${queue.length}`
    : '';

  return (
    <Paper
      elevation={3}
      sx={{
        position: 'fixed',
        bottom: 16,
        left: '50%',
        transform: 'translateX(-50%)',
        width: '80%',
        maxWidth: 900,
        zIndex: 1300,
        p: 2,
        backgroundColor: 'background.paper',
        borderRadius: 2,
        boxShadow: 3
      }}
    >
      <Stack spacing={1}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Typography
            variant="body2"
            sx={{
              flex: 1,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap'
            }}
            title={title}
          >
            {`処理中${indexLabel ? ` (${indexLabel})` : ''}: ${title}`}
          </Typography>
          <Tooltip title="停止">
            <span>
              <IconButton
                size="small"
                onClick={stopProcessing}
                disabled={!isProcessing}
                aria-label="停止"
              >
                <Stop fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
        </Box>

        <Stack spacing={0.75}>
          <Box>
            <Typography variant="caption">生成: {(generating * 100).toFixed(1)}%</Typography>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <LinearProgress sx={{ flex: 1 }} variant="determinate" value={generating * 100} />
              <Box sx={{ width: 16, display: 'flex', justifyContent: 'flex-end' }}>
                {activeStage === 'generating' ? (
                  <CircularProgress size={12} thickness={5} />
                ) : null}
              </Box>
            </Box>
          </Box>
          <Box>
            <Typography variant="caption">動画: {(video * 100).toFixed(1)}%</Typography>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <LinearProgress sx={{ flex: 1 }} variant="determinate" value={video * 100} />
              <Box sx={{ width: 16, display: 'flex', justifyContent: 'flex-end' }}>
                {activeStage === 'video' ? (
                  <CircularProgress size={12} thickness={5} />
                ) : null}
              </Box>
            </Box>
          </Box>
          <Box>
            <Typography variant="caption" sx={{ color: uploadDisabled ? 'text.disabled' : 'text.primary' }}>
              アップロード: {(upload * 100).toFixed(1)}%
            </Typography>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <LinearProgress
                sx={{
                  flex: 1,
                  ...(uploadDisabled
                    ? {
                      backgroundColor: 'grey.200',
                      '& .MuiLinearProgress-bar': {
                        backgroundColor: 'grey.400'
                      }
                    }
                    : null)
                }}
                variant="determinate"
                value={upload * 100}
              />
              <Box sx={{ width: 16, display: 'flex', justifyContent: 'flex-end' }}>
                {!uploadDisabled && activeStage === 'upload' ? (
                  <CircularProgress size={12} thickness={5} />
                ) : null}
              </Box>
            </Box>
          </Box>
        </Stack>
      </Stack>
    </Paper>
  );
};

module.exports = PodCastProgressBar;

