# CUDA-enabled PyTorch base; also runs on CPU (slowly) when no GPU is available.
FROM pytorch/pytorch:2.5.1-cuda12.4-cudnn9-runtime

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    HF_HOME=/models \
    TORCHINDUCTOR_CACHE_DIR=/models/torchinductor \
    TRITON_CACHE_DIR=/models/triton

# gcc builds Triton's launcher when TTS_COMPILE is enabled.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git gcc libc6-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install -r requirements.txt

COPY app.py .

EXPOSE 8890
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8890"]
