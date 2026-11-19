#!/bin/bash
# Downloads every local voice and speech-recognition model into $LOCAL_AI_HOME/models.
# Safe to re-run: anything already present is skipped. About 12 GB in total.
#
#   LOCAL_AI_HOME=~/linguest VOICE_VENV=~/linguest/tts-venv bash local-ai/download-models.sh
set -euo pipefail
LOCAL_AI_HOME=${LOCAL_AI_HOME:-$HOME/linguest}
VOICE_VENV=${VOICE_VENV:-$LOCAL_AI_HOME/tts-venv}
M=$LOCAL_AI_HOME/models
mkdir -p "$M/indictts" "$M/piper"
say(){ printf '\n== %s\n' "$*"; }

# 1. AI4Bharat Indic-TTS (FastPitch + HiFi-GAN, MIT): female voice for Indian base languages.
for l in te hi ta kn ml or; do
  if [ -f "$M/indictts/$l/fastpitch/best_model.pth" ]; then echo "indictts/$l: present"; continue; fi
  say "Indic-TTS $l"
  tmp=$(mktemp -d)
  curl -fL --retry 3 -o "$tmp/$l.zip" "https://github.com/AI4Bharat/Indic-TTS/releases/download/v1-checkpoints-release/$l.zip"
  unzip -q "$tmp/$l.zip" -d "$tmp/x"
  rm -rf "$M/indictts/$l"; mv "$tmp/x/$l" "$M/indictts/$l"; rm -rf "$tmp"
done

# 2. Piper female voices (MIT) for de, nl, pl, ru, sv, zh.
for v in de_DE-kerstin-medium nl_BE-nathalie-medium pl_PL-gosia-medium ru_RU-irina-medium \
         sv_SE-lisa-medium zh_CN-huayan-medium; do
  if [ -f "$M/piper/$v.onnx" ]; then echo "piper/$v: present"; continue; fi
  say "Piper $v"
  locale=${v%%-*}; rest=${v#*-}; name=${rest%-*}; quality=${rest##*-}
  base="https://huggingface.co/rhasspy/piper-voices/resolve/main/${locale%%_*}/$locale/$name/$quality/$v"
  curl -fL --retry 3 -o "$M/piper/$v.onnx" "$base.onnx"
  curl -fL --retry 3 -o "$M/piper/$v.onnx.json" "$base.onnx.json"
done

# 3. Supertonic 3 (OpenRAIL): female voice F1 for ko, tr, ro, da, fi, hr.
if [ -f "$M/supertonic3/onnx/vocoder.onnx" ]; then echo "supertonic3: present"; else
  say "Supertonic 3"
  SUPERTONIC_CACHE_DIR="$M/supertonic3" "$VOICE_VENV/bin/python" -c \
    "from supertonic import TTS; TTS(auto_download=True); print('ok')"
fi

# 4. Language-specific Whisper fine-tunes (vasista22, IIT Madras), converted to CTranslate2.
#    The general Whisper model mangles real-world Telugu/Hindi/Tamil/Kannada/Gujarati speech.
for l in telugu hindi tamil kannada gujarati; do
  out="$M/whisper-$l-small-ct2"
  if [ -f "$out/model.bin" ]; then echo "whisper-$l: present"; continue; fi
  say "Whisper fine-tune $l"
  "$VOICE_VENV/bin/ct2-transformers-converter" --model "vasista22/whisper-$l-small" \
    --output_dir "$out" --quantization int8_float16 --copy_files preprocessor_config.json
done
# The converter caches the original checkpoints (~3 GB each); they are no longer needed.
rm -rf "$HOME"/.cache/huggingface/hub/models--vasista22--whisper-*

say "Done"; du -sh "$M"/* 2>/dev/null
