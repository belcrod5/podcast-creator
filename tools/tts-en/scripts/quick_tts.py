#!/usr/bin/env python

from __future__ import annotations

import sys
from pathlib import Path

import torch
from TTS.api import TTS

from voice_configs import VOICE_CONFIG_MAP, available_voice_summary


def _usage() -> str:
    prog = Path(sys.argv[0]).name
    return (
        f"Usage: {prog} <voice_id> \"テキスト\" \"/path/to/output.wav\"\n"
        f"       {prog} --list  # 声ID一覧"
    )


def main() -> None:
    if len(sys.argv) == 2 and sys.argv[1] in {"--list", "-l"}:
        print("Available voice IDs:")
        print(available_voice_summary())
        return

    if len(sys.argv) != 4:
        print(_usage(), file=sys.stderr)
        raise SystemExit(1)

    voice_id = sys.argv[1]
    text = sys.argv[2]
    out_path = Path(sys.argv[3]).expanduser()
    out_path.parent.mkdir(parents=True, exist_ok=True)

    try:
        cfg = VOICE_CONFIG_MAP[voice_id]
    except KeyError:
        print(f"[quick-tts] Unknown voice_id '{voice_id}'\n", file=sys.stderr)
        print(available_voice_summary(), file=sys.stderr)
        raise SystemExit(1)

    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(
        f"[quick-tts] id={cfg.id} label={cfg.label} model={cfg.model} device={device}"
    )
    print(f"[quick-tts] Generating -> {out_path}")

    tts = TTS(model_name=cfg.model, progress_bar=False).to(device)
    kwargs = {"text": text, "file_path": str(out_path)}
    if cfg.speaker is not None:
        kwargs["speaker"] = cfg.speaker
    tts.tts_to_file(**kwargs)

    print("[quick-tts] Done.")


if __name__ == "__main__":
    main()

