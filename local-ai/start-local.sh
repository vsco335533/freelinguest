#!/bin/bash
# Starts the whole local stack and prints the public URL. Run after every reboot:
#   bash local-ai/start-local.sh
#
#   Redis (:6379) and Kokoro (:8880)  Docker containers (started if stopped)
#   Ollama (:11434)                   system service (expected to be running)
#   Whisper speech recognition :9000  local-ai/whisper_asr_server.py
#   Voice server :8890                local-ai/voice_server.py
#   Backend :8000, frontend :3000     this repository
#   Cloudflare quick tunnel           public https://<random>.trycloudflare.com URL (TUNNEL=0 to skip)
#
# Services already listening are left alone. Logs go to $LOCAL_AI_HOME/logs/.
# Every path can be overridden with the variables below.
REPO=${REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}
LOCAL_AI_HOME=${LOCAL_AI_HOME:-$HOME/linguest}
WHISPER_VENV=${WHISPER_VENV:-$LOCAL_AI_HOME/whisper-venv}
VOICE_VENV=${VOICE_VENV:-$LOCAL_AI_HOME/tts-venv}
CLOUDFLARED=${CLOUDFLARED:-$(command -v cloudflared || echo "$REPO/.local/bin/cloudflared")}
TUNNEL=${TUNNEL:-1}
LOGS=$LOCAL_AI_HOME/logs
export LOCAL_AI_HOME
mkdir -p "$LOGS"

up(){ ss -ltn | grep -q ":$1 "; }
# launch <dir> <logfile> <command...>: fully detached (own session, no inherited stdin/stdout).
launch(){ local dir=$1 log=$2; shift 2; (cd "$dir" && exec setsid "$@" >> "$log" 2>&1 < /dev/null) > /dev/null 2>&1 < /dev/null & }

for c in freelingo-redis freelingo-kokoro; do
  if docker inspect "$c" > /dev/null 2>&1; then
    [ "$(docker inspect -f '{{.State.Running}}' "$c")" = true ] || docker start "$c" > /dev/null
  else
    echo "WARNING: container $c does not exist (see DEPLOYMENT.md, step 3)"
  fi
done
up 11434 || echo "WARNING: Ollama is not listening on :11434 (sudo systemctl start ollama)"

up 9000 || launch "$REPO/local-ai" "$LOGS/whisper.log" "$WHISPER_VENV/bin/python" whisper_asr_server.py
up 8890 || launch "$REPO/local-ai" "$LOGS/voice.log" "$VOICE_VENV/bin/python" voice_server.py
up 8000 || launch "$REPO/backend" "$LOGS/backend.log" "$REPO/.venv/bin/python" -m uvicorn app.main:app --host 0.0.0.0 --port 8000
if ! up 3000; then
  start_frontend(){ SWC_NATIVE_BINDING_CACHE=$HOME/.cache/freelingo-swc launch "$REPO" "$LOGS/frontend.log" "$REPO/scripts/local.sh" frontend npm run dev; }
  start_frontend
  # Next.js may exit once on first start to print an upgrade notice; start it a second time if so.
  for i in $(seq 1 20); do up 3000 && break; sleep 1; done; sleep 3
  up 3000 || start_frontend
fi
if [ "$TUNNEL" = 1 ] && ! pgrep -f "cloudflared tunnel" > /dev/null; then
  : > "$LOGS/tunnel.log"
  launch "$LOCAL_AI_HOME" "$LOGS/tunnel.log" "$CLOUDFLARED" tunnel --url http://localhost:3000 --no-autoupdate
fi

echo "Waiting for services (up to 3 minutes)..."
for i in $(seq 1 180); do
  up 9000 && up 8890 && up 8000 && up 3000 && { [ "$TUNNEL" != 1 ] || grep -q 'trycloudflare.com' "$LOGS/tunnel.log" 2>/dev/null; } && break
  sleep 1
done
for p in 6379 8880 11434 9000 8890 8000 3000; do up $p && echo "port $p: up" || echo "port $p: DOWN (see $LOGS)"; done
[ "$TUNNEL" = 1 ] && echo "Public URL: $(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOGS/tunnel.log" | tail -1)"
exit 0
