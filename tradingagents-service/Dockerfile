# TradingAgents sidecar service for Chloei.
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    HOST=0.0.0.0 \
    PORT=8000 \
    # Keep the framework's per-run artifacts inside the container's writable
    # home so runs don't try to write to a read-only path.
    TRADINGAGENTS_RESULTS_DIR=/data/logs \
    TRADINGAGENTS_CACHE_DIR=/data/cache

# git is required to pip-install TradingAgents from its GitHub repo;
# build-essential covers any sdist-only transitive deps.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git build-essential curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /srv

COPY requirements.txt ./
RUN pip install --upgrade pip && pip install -r requirements.txt

COPY app ./app

RUN mkdir -p /data/logs /data/cache

# Run as an unprivileged user that owns the writable data dirs, so a compromise
# of the sidecar (it holds the gateway key) doesn't inherit root in the
# container.
RUN useradd --system --uid 10001 --create-home appuser \
    && chown -R appuser:appuser /data /srv
USER appuser

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS "http://localhost:${PORT:-8000}/health" || exit 1

# Bind to the platform-assigned $PORT (Render/Railway/Fly inject it); default to
# 8000 for local docker-compose. `exec` makes uvicorn PID 1 so it receives
# shutdown signals.
CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
