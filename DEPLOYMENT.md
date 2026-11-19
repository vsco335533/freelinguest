# Deployment guide: FreeLingo with fully local AI

This guide deploys FreeLingo on one Linux machine with an NVIDIA GPU. Everything runs locally: the
tutor (Ollama), speech recognition (faster-whisper), and all voices. No cloud API keys are required,
and no audio or text leaves the machine. The site is published on the internet through a Cloudflare
tunnel.

It is written for a fresh Ubuntu 22.04/24.04 machine, but every step names the exact command and
how to verify it, so it can be adapted. For the stock Docker Compose deployment with cloud or
default local speech, see [README.md](README.md#quick-start) instead.

---

## Contents

1. [What gets deployed](#1-what-gets-deployed)
2. [Hardware and software requirements](#2-hardware-and-software-requirements)
3. [Step 1: system packages, NVIDIA driver and Docker](#step-1-system-packages-nvidia-driver-and-docker)
4. [Step 2: clone the repository and install the app](#step-2-clone-the-repository-and-install-the-app)
5. [Step 3: Redis and Kokoro containers](#step-3-redis-and-kokoro-containers)
6. [Step 4: Ollama and the language model](#step-4-ollama-and-the-language-model)
7. [Step 5: speech recognition server (Whisper)](#step-5-speech-recognition-server-whisper)
8. [Step 6: voice server](#step-6-voice-server)
9. [Step 7: download the models](#step-7-download-the-models)
10. [Step 8: configure the backend and frontend](#step-8-configure-the-backend-and-frontend)
11. [Step 9: start everything](#step-9-start-everything)
12. [Step 10: verify the deployment](#step-10-verify-the-deployment)
13. [Public access (Cloudflare tunnel)](#public-access-cloudflare-tunnel)
14. [Start automatically after a reboot](#start-automatically-after-a-reboot)
15. [How the speech pipeline works](#how-the-speech-pipeline-works)
16. [Configuration reference](#configuration-reference)
17. [Day-to-day operations](#day-to-day-operations)
18. [Troubleshooting](#troubleshooting)
19. [Security checklist](#security-checklist)

---

## 1. What gets deployed

| Service | Port | Runs as | Device | Purpose |
|---|---|---|---|---|
| Frontend (Next.js) | 3000 | `scripts/local.sh frontend npm run dev` | CPU | Web app |
| Backend (FastAPI) | 8000 | `uvicorn app.main:app` | CPU | API, WebSocket conversation, lessons, listening |
| Redis | 6379 | Docker `freelingo-redis` | CPU | Rate limits, generation locks |
| Ollama (`gemma4:e4b`) | 11434 | system service | GPU (~4.6 GB) | Tutor replies, lesson and exercise generation |
| Kokoro TTS | 8880 | Docker `freelingo-kokoro` | GPU (~0.75 GB) | English, Spanish, French, Italian, Portuguese, Japanese voices |
| Whisper ASR | 9000 | `local-ai/whisper_asr_server.py` | GPU (~1 GB) | Speech recognition for every language |
| Voice server | 8890 | `local-ai/voice_server.py` | CPU | Female voices for Indian base languages and the other target languages |
| Cloudflare tunnel | none | `cloudflared` | CPU | Public HTTPS URL |
| Database | none | SQLite file | CPU | `data/dev.db` (PostgreSQL also supported) |

How a spoken conversation turn flows:

```
Browser mic ─► backend /ws ─► Whisper :9000 (language-specific model) ─► text
            ◄─ audio ◄──── Kokoro :8880 / voice server :8890 ◄─ sentences ◄─ Ollama :11434 (streamed)
```

The backend streams the tutor's reply sentence by sentence. Each sentence is spoken as soon as it is
complete, so the first audio arrives about 1.3–1.6 s after the student stops speaking.

---

## 2. Hardware and software requirements

| Item | Minimum | Used in testing |
|---|---|---|
| GPU | NVIDIA, 8 GB VRAM, driver ≥ 535 | GeForce RTX 3050 8 GB, driver 550.163.01 (CUDA 12.4) |
| CPU | 8 cores | 12 cores |
| RAM | 16 GB | 16 GB+ (voice server holds up to 4 voice models) |
| Disk | 40 GB free | Ollama model 6.6 GB, voice and Whisper models ~12 GB, Docker images ~10 GB |
| OS | Ubuntu 22.04 or 24.04, x86_64 | Ubuntu 22.04, kernel 6.8 |

The GPU memory budget is tight on 8 GB. Do not add a second large model:

| Process | VRAM |
|---|---|
| Ollama `gemma4:e4b` | ~4.6 GB |
| Whisper `large-v3-turbo` (int8_float16) | ~1.0 GB |
| Kokoro | ~0.75 GB |
| Language-specific Whisper models (loaded on first use) | ~0.25 GB each |
| **Total in normal use** | **~6.7 GB of 8 GB** |

The full Whisper `large-v3` model does **not** fit next to Ollama (it fails with "out of memory").
The voice server is deliberately CPU-only for the same reason.

---

## Step 1: system packages, NVIDIA driver and Docker

```bash
sudo apt update
sudo apt install -y git curl unzip ffmpeg iproute2 build-essential \
    python3.11 python3.11-venv python3.11-dev espeak-ng
```

On Ubuntu 24.04, Python 3.11 comes from the deadsnakes PPA:

```bash
sudo add-apt-repository -y ppa:deadsnakes/ppa && sudo apt update
sudo apt install -y python3.11 python3.11-venv python3.11-dev
```

> Python 3.12 venvs without `ensurepip` fail to create; use 3.11 for the two speech servers.
> The FreeLingo backend itself uses its own bundled Python 3.14 (Step 2).

**NVIDIA driver.** Check the driver first:

```bash
nvidia-smi                       # must list the GPU, the driver version and "CUDA Version"
```

If it is missing:

```bash
sudo ubuntu-drivers install      # installs the recommended driver
sudo reboot
```

**Docker and the NVIDIA container toolkit:**

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"            # log out and back in afterwards

curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey \
  | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
  | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#' \
  | sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list
sudo apt update && sudo apt install -y nvidia-container-toolkit
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker
```

Verify that containers can see the GPU:

```bash
docker run --rm --gpus all ubuntu nvidia-smi
```

Redis recommends memory overcommit on Linux hosts:

```bash
echo 'vm.overcommit_memory = 1' | sudo tee /etc/sysctl.d/99-redis.conf
sudo sysctl --system
```

---

## Step 2: clone the repository and install the app

The local AI files live outside the repository in one folder, `~/linguest` by default (set
`LOCAL_AI_HOME` to change it). The repository is cloned inside it:

```bash
mkdir -p ~/linguest && cd ~/linguest
git clone https://github.com/vsco335533/freelinguest.git
cd freelinguest
```

Install the pinned Python 3.14 and Node toolchain, the backend virtualenv (`.venv`) and the frontend
`node_modules` in one step (see [DEVELOPMENT.md](DEVELOPMENT.md) for details):

```bash
./scripts/bootstrap.sh
```

Verify:

```bash
./scripts/local.sh backend python --version        # Python 3.14.x
./scripts/local.sh frontend node --version         # v26.x
```

---

## Step 3: Redis and Kokoro containers

**Redis:**

```bash
docker run -d --name freelingo-redis --restart unless-stopped \
  -p 127.0.0.1:6379:6379 -v freelingo-redis:/data redis:7-alpine
docker exec freelingo-redis redis-cli ping           # PONG
```

**Kokoro** (English, Spanish, French, Italian, Portuguese and Japanese voices):

```bash
docker run -d --name freelingo-kokoro --restart unless-stopped --gpus all \
  -p 127.0.0.1:8880:8880 \
  -e LD_LIBRARY_PATH=/usr/lib/x86_64-linux-gnu:/usr/local/nvidia/lib:/usr/local/nvidia/lib64 \
  ghcr.io/remsky/kokoro-fastapi-gpu:latest
```

> **Do not drop the `LD_LIBRARY_PATH` line.** The image ships CUDA "forward compatibility" driver
> libraries meant for datacenter GPUs. On GeForce cards with an older driver, CUDA fails with
> error 804 and Kokoro silently falls back to the CPU, making long audio 6–9× slower (a C2
> listening exercise takes 42 s instead of 4.7 s). The variable makes the container load the host
> driver instead. The same fix is in `docker-compose.yml`.

Verify that Kokoro runs on the GPU (takes about 15 s after start):

```bash
docker logs freelingo-kokoro 2>&1 | grep -E "Loading Kokoro model on|CUDA:"
#  Loading Kokoro model on cuda
#  CUDA: True
curl -s localhost:8880/v1/models | head -c 200; echo
```

If it says `on cpu` or `CUDA: False`, see [Troubleshooting](#kokoro-runs-on-the-cpu-slow-voices).

---

## Step 4: Ollama and the language model

```bash
curl -fsSL https://ollama.com/install.sh | sh        # installs and starts the ollama service
ollama pull gemma4:e4b                               # 6.6 GB
ollama list
```

Keep the model loaded in GPU memory permanently, so the first reply after a quiet period is not
slow. The backend also pins it at startup, but setting it at the service level makes it survive
backend restarts:

```bash
sudo systemctl edit ollama
# add these lines, save, then:
#   [Service]
#   Environment="OLLAMA_KEEP_ALIVE=-1"
sudo systemctl restart ollama
```

Verify:

```bash
curl -s localhost:11434/api/tags | head -c 200; echo
curl -s localhost:11434/api/generate -d '{"model":"gemma4:e4b","prompt":"Say hi","stream":false}' \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["response"])'
```

---

## Step 5: speech recognition server (Whisper)

The stock Whisper container mishears Telugu and other Indian languages on real microphones; it
labels Telugu as Hindi, Urdu, English or even Indonesian. `local-ai/whisper_asr_server.py` fixes
this by:

- using language-specific fine-tuned models for Telugu, Hindi, Tamil, Kannada and Gujarati;
- restricting detection to the learner's own languages (base language plus target language).

Create its virtualenv:

```bash
cd ~/linguest
python3.11 -m venv whisper-venv
whisper-venv/bin/pip install --upgrade pip
whisper-venv/bin/pip install -r freelinguest/local-ai/requirements-whisper.txt
```

The `large-v3-turbo` model (~1.6 GB) downloads automatically on the first start. The language
models are installed in [Step 7](#step-7-download-the-models).

Test it on its own:

```bash
cd ~/linguest/freelinguest/local-ai
../../whisper-venv/bin/python whisper_asr_server.py      # Ctrl+C to stop after testing
# in another terminal:
curl -s localhost:9000/                                    # {"status":"ok","model":"large-v3-turbo"}
```

---

## Step 6: voice server

`local-ai/voice_server.py` provides a **female** voice for:

- every Indian base language, so the learner's native-language help is spoken;
- every target language that Kokoro cannot speak well.

It runs on the CPU only.

```bash
cd ~/linguest
python3.11 -m venv tts-venv
tts-venv/bin/pip install --upgrade pip
# CPU-only torch first (otherwise pip pulls the 2+ GB CUDA build):
tts-venv/bin/pip install --index-url https://download.pytorch.org/whl/cpu torch==2.11.0 torchaudio==2.11.0
tts-venv/bin/pip install -r freelinguest/local-ai/requirements-voice.txt
```

Voices by language:

| Language(s) | Engine | Voice | License |
|---|---|---|---|
| Telugu, Hindi, Tamil, Kannada, Malayalam, Odia | AI4Bharat Indic-TTS (FastPitch + HiFi-GAN) | `female` speaker | MIT |
| English (en-GB), Spanish, French, Italian, Portuguese, Japanese | Kokoro (proxied to :8880) | `bf_emma`, `ef_dora`, `ff_siwis`, `if_sara`, `pf_dora`, `jf_alpha` | Apache-2.0 |
| German, Dutch, Polish, Russian, Swedish, Chinese | Piper | `kerstin`, `nathalie`, `gosia`, `irina`, `lisa`, `huayan` | MIT |
| Korean, Turkish, Romanian, Danish, Finnish, Croatian | Supertonic 3 | `F1` | OpenRAIL |

All voices go through the same "soft finish" audio filter: rumble and hiss removed, harsh
3–5 kHz tamed, light denoise, short padding, and loudness matched to the English voice. They are
also spoken at 0.9× speed for clarity.

Long text, such as a listening exercise, is spoken in sentence groups of at most 250 characters,
because some models fail or drift on very long input.

---

## Step 7: download the models

```bash
cd ~/linguest/freelinguest
LOCAL_AI_HOME=~/linguest VOICE_VENV=~/linguest/tts-venv bash local-ai/download-models.sh
```

This takes 20–60 minutes depending on bandwidth, and is safe to re-run. It downloads:

| Folder in `~/linguest/models` | Size | Contents |
|---|---|---|
| `indictts/{te,hi,ta,kn,ml,or}` | ~9.3 GB | Indic-TTS checkpoints from the AI4Bharat GitHub release |
| `piper/*.onnx` | ~0.4 GB | Six Piper voices from `rhasspy/piper-voices` |
| `supertonic3/` | ~0.4 GB | Supertonic 3 from `Supertone/supertonic-3` |
| `whisper-{telugu,hindi,tamil,kannada,gujarati}-small-ct2` | ~1.2 GB | `vasista22/whisper-<lang>-small`, converted to CTranslate2 int8 |

At the end the script deletes the original Hugging Face checkpoints of the Whisper models (~15 GB)
from `~/.cache/huggingface`, because only the converted copies are used.

Verify:

```bash
ls ~/linguest/models
ls ~/linguest/models/indictts/te/fastpitch/best_model.pth ~/linguest/models/whisper-telugu-small-ct2/model.bin
```

---

## Step 8: configure the backend and frontend

```bash
cd ~/linguest/freelinguest
cp .env.example backend/.env
openssl rand -hex 32              # paste the output as SECRET_KEY below
nano backend/.env
```

Settings for this deployment (everything else can keep its default):

```dotenv
SECRET_KEY=<output of openssl rand -hex 32>
DATABASE_URL=sqlite+aiosqlite:////home/<user>/linguest/freelinguest/data/dev.db
REDIS_URL=redis://localhost:6379/0
CORS_ORIGINS=["http://localhost:3000","http://127.0.0.1:3000"]
FIRST_USER_IS_ADMIN=true          # the first account registered becomes admin

LLM_PROVIDER=ollama
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=gemma4:e4b
OLLAMA_STREAM_REASONING_EFFORT=none

TTS_PROVIDER=local
TTS_BASE_URL=http://localhost:8880
TTS_VOICE=af_heart
NATIVE_TTS_BASE_URL=http://localhost:8890

STT_PROVIDER=local
STT_BASE_URL=http://localhost:9000

EXERCISE_GENERATION_TIMEOUT_SECONDS=300
UVICORN_WORKERS=1
```

Create the database folder (the backend creates and migrates the database on its first start):

```bash
mkdir -p data
```

Frontend:

```bash
cat > frontend/.env.local <<'EOF'
NEXT_PUBLIC_API_URL=http://localhost:8000
BACKEND_URL=http://localhost:8000
EOF
```

`NEXT_PUBLIC_API_URL` must stay `localhost`. The browser reaches the API through Next.js on the
same origin, which is what makes the tunnel work.

---

## Step 9: start everything

```bash
bash ~/linguest/freelinguest/local-ai/start-local.sh
```

The script:

1. starts the Redis and Kokoro containers if they are stopped, and warns if Ollama is down;
2. starts Whisper (:9000), the voice server (:8890), the backend (:8000) and the frontend (:3000),
   each fully detached;
3. starts the Cloudflare tunnel and prints the public URL.

It leaves any service that is already running alone, so it is safe to run again at any time.
Expected output:

```
port 6379: up
port 8880: up
port 11434: up
port 9000: up
port 8890: up
port 8000: up
port 3000: up
Public URL: https://<random-words>.trycloudflare.com
```

Overrides, if your layout differs:

```bash
LOCAL_AI_HOME=/srv/linguest WHISPER_VENV=/srv/venvs/whisper VOICE_VENV=/srv/venvs/tts \
CLOUDFLARED=/usr/local/bin/cloudflared TUNNEL=0 bash local-ai/start-local.sh
```

The first frontend start compiles pages and can take a minute; Next.js may also exit once to print
an upgrade notice. The script restarts it automatically in that case.

Open `http://localhost:3000`, register the first account (it becomes the admin), and create a study
plan.

---

## Step 10: verify the deployment

Health of each service:

```bash
curl -s localhost:8000/health; echo                        # backend (also checks LLM/TTS/STT)
curl -s localhost:8890/; echo                              # voice server: loaded voices + languages
curl -s localhost:9000/; echo                              # whisper
curl -s localhost:8880/v1/models | head -c 120; echo       # kokoro
nvidia-smi --query-gpu=memory.used,memory.total --format=csv
```

Voice round trip: speak Telugu, then have Whisper recognise it.

```bash
curl -s -X POST localhost:8890/v1/audio/speech -H 'content-type: application/json' \
  -d '{"input":"మీకు ఏ ఆట ఇష్టం?","language":"te"}' -o /tmp/te.mp3
curl -s -F audio_file=@/tmp/te.mp3 "localhost:9000/asr?language=te"; echo
# {"text":"నీకు ఏ ఆట ఇష్టం", "language":"te", ...}
```

A target language through Kokoro on the GPU (should be well under 1 s):

```bash
time curl -s -X POST localhost:8880/v1/audio/speech -H 'content-type: application/json' \
  -d '{"model":"kokoro","input":"That sounds lovely.","voice":"bf_emma","response_format":"mp3"}' -o /tmp/en.mp3
```

Backend tests for the voice pipeline:

```bash
./scripts/local.sh backend python -m pytest -q --no-cov \
  tests/test_voice_latency.py tests/test_tts_service.py tests/test_stt_language_retry.py
```

In the app:

1. **Conversation:** speak your base language and the target language. Both are understood. The
   reply is spoken in the target voice, with native-language help in the base-language voice.
2. **Lessons:** every speaker button plays the target language.
3. **Listening:** a new exercise generates in 15–60 s depending on level.

---

## Public access (Cloudflare tunnel)

### Quick tunnel (default, no account)

`start-local.sh` runs a quick tunnel:

```bash
cloudflared tunnel --url http://localhost:3000 --no-autoupdate
```

Install `cloudflared` if needed:

```bash
curl -fL -o cloudflared.deb \
  https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
sudo dpkg -i cloudflared.deb
```

> **The quick-tunnel URL changes every time the tunnel restarts**, including after every reboot.
> An old URL then shows `DNS_PROBE_FINISHED_NXDOMAIN`. Get the current one with:
>
> ```bash
> grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' ~/linguest/logs/tunnel.log | tail -1
> ```

WebSockets (`/ws/*`, needed for spoken conversation) work through the tunnel without extra
configuration.

### Named tunnel (stable URL on your own domain)

For a permanent address, use a named tunnel. This requires a free Cloudflare account and a domain on
Cloudflare:

```bash
cloudflared tunnel login                                   # opens a browser to authorise
cloudflared tunnel create freelingo
cloudflared tunnel route dns freelingo learn.example.com
cat > ~/.cloudflared/config.yml <<'EOF'
tunnel: freelingo
credentials-file: /home/<user>/.cloudflared/<tunnel-id>.json
ingress:
  - hostname: learn.example.com
    service: http://localhost:3000
  - service: http_status:404
EOF
sudo cloudflared service install                           # runs at boot as a system service
```

Then start the stack with `TUNNEL=0 bash local-ai/start-local.sh`, and add the new origin to
`CORS_ORIGINS` in `backend/.env`.

---

## Start automatically after a reboot

Docker containers (`--restart unless-stopped`) and Ollama (a systemd service) restart on their own.
The rest is started by `start-local.sh`. Choose one method.

**Option A: cron (simplest)**

```bash
crontab -e
# add:
@reboot sleep 30 && bash /home/<user>/linguest/freelinguest/local-ai/start-local.sh >> /home/<user>/linguest/logs/boot.log 2>&1
```

**Option B: systemd user service**

```bash
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/freelingo.service <<'EOF'
[Unit]
Description=FreeLingo local stack
After=network-online.target docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStartPre=/bin/sleep 20
ExecStart=/bin/bash %h/linguest/freelinguest/local-ai/start-local.sh

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable freelingo.service
sudo loginctl enable-linger "$USER"       # run user services without logging in
```

After a reboot, get the new public URL as shown in [Public access](#public-access-cloudflare-tunnel).

---

## How the speech pipeline works

### Recognition: which language did the student speak?

The backend sends Whisper the learner's languages, base language first (`languages=te,en`). Whisper
then:

1. detects the language with the general `large-v3-turbo` model;
2. accepts a **target** language only when detection is confident: English ≥ 0.9, others ≥ 0.6
   (`WHISPER_EN_MIN_PROB`, `WHISPER_OTHER_MIN_PROB`);
3. treats anything else as the **base** language. Whisper rarely identifies Telugu correctly on real
   microphones, but scores target-language speech at 0.94–1.0, so this rule is reliable;
4. transcribes with the language's fine-tuned model if one exists (te, hi, ta, kn, gu), otherwise
   with `large-v3-turbo`. It uses beam search 5 for non-English, greedy for English, voice-activity
   filtering to drop silence, and no conditioning on previous text, to stop repetition loops.

### Speaking: which voice says what?

The tutor replies in the target language, with native-language help in `[brackets]`. The backend
splits each reply into parts:

- target-language text goes to `KokoroTTSService`. English uses Kokoro directly (British `bf_emma`
  for en-GB); every other language is routed to the voice server;
- `[bracketed help]` and loose words in the base-language script go to the voice server in the
  base language;
- romanisation in `(parentheses)` after native text is dropped, so it is not read twice.

If the voice server is unreachable, target-language speech falls back to Kokoro rather than going
silent. It does **not** fall back after a timeout: an English voice reading Chinese for minutes is
worse than an error.

### Latency

- The LLM streams; complete sentences (`. ! ? ।` followed by a space, or `。！？`) are synthesized
  while the rest is still being written.
- Hidden "thinking" is disabled for streamed replies (`OLLAMA_STREAM_REASONING_EFFORT=none`), which
  saves about 3.5 s.
- The Ollama model is pinned in memory at backend startup.
- When the tutor uses a tool (for example saving a memory), a repeated reply is suppressed.

### Lessons and listening

Lesson, flashcard and game audio buttons call `POST /api/tts` with the study plan, so they use the
same per-language voices. Listening exercises synthesize the whole story once and store the MP3 in
`AUDIO_STORAGE_PATH`. Speech timeouts grow with text length (`30 s + 0.2 s per character` for
Kokoro, `60 s + 0.2 s per character` for the voice server, capped at 900 s).

Measured voice times for a C2-length listening text (~450 words):

| Voices | Time |
|---|---|
| German, Polish, Russian, Chinese (Piper) | 7–10 s |
| English, Spanish, French (Kokoro, GPU) | 4.7–6.5 s |
| Japanese (Kokoro, GPU) | 8.4 s |
| Korean, Turkish (Supertonic, CPU) | 39–46 s |

---

## Configuration reference

### Backend (`backend/.env`), speech-related

| Variable | Value here | Meaning |
|---|---|---|
| `TTS_PROVIDER` | `local` | Kokoro plus the voice server (`openai` uses OpenAI TTS instead) |
| `TTS_BASE_URL` | `http://localhost:8880` | Kokoro |
| `TTS_VOICE` | `af_heart` | Default English voice (en-GB uses `bf_emma` automatically) |
| `NATIVE_TTS_BASE_URL` | `http://localhost:8890` | Voice server; empty disables it (English-only speech) |
| `STT_PROVIDER` / `STT_BASE_URL` | `local` / `http://localhost:9000` | Whisper server |
| `OLLAMA_STREAM_REASONING_EFFORT` | `none` | Thinking level for spoken (streamed) replies |
| `EXERCISE_GENERATION_TIMEOUT_SECONDS` | `300` | Total budget for generating one listening/reading exercise |

### Whisper server (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `LOCAL_AI_HOME` | `~/linguest` | Base folder for models and logs |
| `WHISPER_MODEL` | `large-v3-turbo` | General model |
| `WHISPER_DEVICE` / `WHISPER_COMPUTE_TYPE` | `cuda` / `int8_float16` | Use `cpu` / `int8` without a GPU (much slower) |
| `WHISPER_LANG_MODEL_DIR` | `$LOCAL_AI_HOME/models` | Location of `whisper-<lang>-small-ct2` |
| `WHISPER_EN_MIN_PROB` / `WHISPER_OTHER_MIN_PROB` | `0.9` / `0.6` | Confidence needed to accept a target language |
| `WHISPER_CLIP_KEEP` | `0` | Keep the last N recordings for debugging (stores users' voices) |
| `WHISPER_CLIP_DIR` | `$LOCAL_AI_HOME/logs/asr_clips` | Where those recordings go |
| `WHISPER_HOST` / `WHISPER_PORT` | `127.0.0.1` / `9000` | Listen address |

### Voice server (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `LOCAL_AI_HOME` / `TTS_MODEL_DIR` | `~/linguest` / `$LOCAL_AI_HOME/models` | Model location |
| `KOKORO_URL` | `http://localhost:8880` | Kokoro for es/fr/it/pt/en/ja |
| `TTS_SPEAKING_RATE` | `0.9` | Below 1 is slower and clearer |
| `TTS_MAX_LOADED` | `4` | Voice models kept in RAM (least recently used are unloaded) |
| `TTS_PRELOAD` | `te` | Comma-separated languages loaded at startup |
| `TTS_MAX_CHUNK_CHARS` | `250` | Sentence-group size for long text |
| `TTS_THREADS` | `4` | CPU threads for synthesis |
| `TTS_AUDIO_FILTER` | soft finish chain | ffmpeg filter applied to every voice |
| `TTS_PORT` | `8890` | Listen port (always 127.0.0.1) |

The voice server API, for testing:

```bash
curl -s -X POST localhost:8890/v1/audio/speech -H 'content-type: application/json' \
  -d '{"input":"Guten Tag","language":"de-DE"}' -o out.mp3     # 404 = no voice for that language
```

---

## Day-to-day operations

**Logs** (all in `~/linguest/logs/`):

```bash
tail -f ~/linguest/logs/backend.log       # API, conversation pipeline ("First audio after X ms")
tail -f ~/linguest/logs/whisper.log       # "[asr] detected=hi p=0.41 -> te" lines
tail -f ~/linguest/logs/voice.log
tail -f ~/linguest/logs/frontend.log
docker logs -f freelingo-kokoro
journalctl -u ollama -f
```

**Restart a single service.** Stop it by port, then run the start script, which starts only what
is down:

```bash
stop_port(){ pid=$(ss -ltnp | grep ":$1 " | grep -oP 'pid=\K[0-9]+' | head -1); [ -n "$pid" ] && kill "$pid"; }
stop_port 8000                      # backend   (9000 whisper, 8890 voice, 3000 frontend)
sleep 2 && bash ~/linguest/freelinguest/local-ai/start-local.sh
```

> Do not use `pkill -f voice_server.py` from a shell whose own command line contains that text:
> it kills the shell too. Stopping by port avoids this.

**Restart the containers:**

```bash
docker restart freelingo-kokoro freelingo-redis
```

**Update the code:**

```bash
cd ~/linguest/freelinguest
git pull
./scripts/bootstrap.sh                # only if requirements or package-lock changed
stop_port 8000; stop_port 3000; stop_port 8890; stop_port 9000
bash local-ai/start-local.sh          # database migrations run automatically at backend start
```

**Back up** the database and generated audio:

```bash
tar czf ~/freelingo-backup-$(date +%F).tgz -C ~/linguest/freelinguest data
```

**Check GPU memory:**

```bash
nvidia-smi --query-compute-apps=pid,used_memory,process_name --format=csv
```

---

## Troubleshooting

### The site does not open (`DNS_PROBE_FINISHED_NXDOMAIN`)

The quick-tunnel URL changed: the machine or tunnel restarted. Run the start script and use the URL
it prints:

```bash
bash ~/linguest/freelinguest/local-ai/start-local.sh | tail -1
```

### Kokoro runs on the CPU (slow voices)

Symptoms: lesson audio is slow, listening generation takes minutes, and
`docker logs freelingo-kokoro` shows `Error 804: forward compatibility was attempted on non
supported HW` and `CUDA: False`.

Fix: recreate the container with the `LD_LIBRARY_PATH` line from [Step 3](#step-3-redis-and-kokoro-containers):

```bash
docker rm -f freelingo-kokoro
docker run -d --name freelingo-kokoro --restart unless-stopped --gpus all -p 127.0.0.1:8880:8880 \
  -e LD_LIBRARY_PATH=/usr/lib/x86_64-linux-gnu:/usr/local/nvidia/lib:/usr/local/nvidia/lib64 \
  ghcr.io/remsky/kokoro-fastapi-gpu:latest
```

Test the fix inside a running container before recreating it:

```bash
docker exec -e LD_LIBRARY_PATH=/usr/lib/x86_64-linux-gnu freelingo-kokoro \
  python -c "import torch; print(torch.cuda.is_available())"     # True
```

### Telugu (or another base language) is not understood

- Check that the fine-tuned model exists: `ls ~/linguest/models/whisper-telugu-small-ct2/model.bin`.
- Watch `whisper.log` while speaking. `detected=hi p=0.41 -> te` is normal and correct; the base
  language wins when the detector is unsure.
- Headset microphones that only capture telephone-band audio (nothing above 3.4 kHz) reduce
  accuracy. Speak close to the mic, in a quiet room.
- To debug, temporarily set `WHISPER_CLIP_KEEP=40`, restart Whisper and listen to the files in
  `logs/asr_clips`. Set it back to 0 afterwards.

### Replies are slow

- `grep "First audio after" ~/linguest/logs/backend.log | tail`: expect about 1300–1600 ms.
- Check that Ollama is on the GPU (`ollama ps` shows `100% GPU`) and that
  `OLLAMA_STREAM_REASONING_EFFORT=none` is set.
- Check that Kokoro runs on the GPU (see above).

### A voice is missing or a language returns 404

`curl -s localhost:8890/` lists the supported languages. Re-run `local-ai/download-models.sh`; it
only fetches what is missing. Then restart the voice server.

### "CUDA out of memory" in whisper.log or Ollama

Another process took GPU memory. Check with `nvidia-smi`. Do not switch Whisper to `large-v3` on an
8 GB card. Restart Whisper after freeing memory.

### Frontend: "parent directory is writable by another user" (SWC)

The SWC native binding cache must be private. The start script sets
`SWC_NATIVE_BINDING_CACHE=$HOME/.cache/freelingo-swc`; do the same if you start the frontend by hand.

### Frontend: "Module not found: messages/en.json"

`frontend/next.config.ts` must set `turbopack.root` to the repository root, because
`src/i18n/request.ts` imports from `../../../messages`. This is already done in the repository.

### Listening exercise fails with "generation timed out"

Increase `EXERCISE_GENERATION_TIMEOUT_SECONDS` in `backend/.env` (300 is enough with Kokoro on the
GPU; use 600 if Kokoro is on the CPU) and restart the backend.

### Port already in use

```bash
ss -ltnp | grep -E ':(3000|8000|8880|8890|9000) '
```

---

## Security checklist

- [ ] `SECRET_KEY` is a fresh random value, never the example value.
- [ ] Do not commit `backend/.env` or `frontend/.env.local` (both are git-ignored), and never put
      passwords in the README or other committed files.
- [ ] Whisper (:9000) and the voice server (:8890) listen on `127.0.0.1` only. Redis and Kokoro are
      published on `127.0.0.1` in the commands above. Only the tunnel exposes the app.
- [ ] `WHISPER_CLIP_KEEP=0` in normal operation; recordings are users' voices.
- [ ] Register the admin account yourself right after the first start (`FIRST_USER_IS_ADMIN=true`),
      before sharing the URL.
- [ ] Anyone with the quick-tunnel URL can reach the site; use a named tunnel with Cloudflare Access
      for private deployments.
- [ ] Model licenses: Indic-TTS (MIT), Piper voices (MIT; check each voice's model card), Kokoro
      (Apache-2.0), Supertonic 3 (OpenRAIL: use restrictions apply), Whisper fine-tunes (Apache-2.0),
      `gemma4` (Gemma terms of use).
