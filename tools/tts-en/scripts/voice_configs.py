from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, Tuple


@dataclass(frozen=True)
class VoiceConfig:
    id: str
    label: str
    model: str
    speaker: str | None = None


VOICE_CONFIGS: Tuple[VoiceConfig, ...] = (
    # Single-speaker models
    VoiceConfig(
        id="lj_vits",
        label="Female US (LJSpeech VITS)",
        model="tts_models/en/ljspeech/vits",
    ),
    VoiceConfig(
        id="sam_tacotron",
        label="Neutral Mid (Sam Tacotron-DDC)",
        model="tts_models/en/sam/tacotron-DDC",
    ),
    VoiceConfig(
        id="ek1_tacotron2",
        label="UK Female (ek1 Tacotron2)",
        model="tts_models/en/ek1/tacotron2",
    ),
    # VCTK multi-speaker voices (male group)
    VoiceConfig(
        id="vctk_male_p226",
        label="VCTK Male p226",
        model="tts_models/en/vctk/vits",
        speaker="p226",
    ),
    VoiceConfig(
        id="vctk_male_p229",
        label="VCTK Male p229",
        model="tts_models/en/vctk/vits",
        speaker="p229",
    ),
    VoiceConfig(
        id="vctk_male_p231",
        label="VCTK Male p231",
        model="tts_models/en/vctk/vits",
        speaker="p231",
    ),
    # VCTK female/base voices
    VoiceConfig(
        id="vctk_female_p225",
        label="VCTK Female p225",
        model="tts_models/en/vctk/vits",
        speaker="p225",
    ),
    VoiceConfig(
        id="vctk_female_p228",
        label="VCTK Female p228",
        model="tts_models/en/vctk/vits",
        speaker="p228",
    ),
    # VCTK higher-pitch / character-like voices
    VoiceConfig(
        id="vctk_char_p268",
        label="VCTK Character High p268",
        model="tts_models/en/vctk/vits",
        speaker="p268",
    ),
    VoiceConfig(
        id="vctk_char_p306",
        label="VCTK Character High p306",
        model="tts_models/en/vctk/vits",
        speaker="p306",
    ),
    # VCTK additional speakers (picked from dump_en_model_samples2 outputs)
    VoiceConfig(
        id="vctk_p284",
        label="VCTK p284",
        model="tts_models/en/vctk/vits",
        speaker="p284",
    ),
    VoiceConfig(
        id="vctk_p285",
        label="VCTK p285",
        model="tts_models/en/vctk/vits",
        speaker="p285",
    ),
)


VOICE_CONFIG_MAP: Dict[str, VoiceConfig] = {cfg.id: cfg for cfg in VOICE_CONFIGS}


def available_voice_summary() -> str:
    return "\n".join(f"- {cfg.id}: {cfg.label}" for cfg in VOICE_CONFIGS)

