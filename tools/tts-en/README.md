# TTS 使い方

```
source .venv/bin/activate
python scripts/quick_tts.py --list
python scripts/quick_tts.py <voice_id> "テキスト" "/abs/path/output.wav"
```

`--list` で使える `voice_id` とラベルを表示。  
`voice_id` は `scripts/voice_configs.py` の `VOICE_CONFIGS` で定義した声（例：`lj_vits`, `sam_tacotron`, `vctk_char_p268` など）と一致。

`/tmp/...` など任意パスに出力可能。仮想環境を有効化せずに実行すると `coqui-tts` が見つからないので注意。

# TTS モデルダウンロード場所
`~/Library/Application Support/tts/`