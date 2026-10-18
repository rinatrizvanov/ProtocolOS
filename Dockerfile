# ProtocolOS: one container (FastAPI + static web/ + poppler), public-demo guard on.
FROM python:3.13-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends poppler-utils \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1

# dependencies from pyproject.toml (AGENTS.md section 8 one-liner; no uv needed)
COPY pyproject.toml ./
RUN pip install $(python -c "import tomllib;d=tomllib.load(open('pyproject.toml','rb'));print(' '.join(d['project']['dependencies']+d['dependency-groups']['dev']))")

COPY . .

# Build-time prewarm of the demo trials, plus the authoring-mode draft presets when trialforge.draft is
# present. Exits 0 without network or on HTTP 403; the startup prewarm below then fills whatever is
# missing before the server listens.
RUN python -m scripts.prewarm --drafts NCT03409614 NCT02578680 NCT03088540 NCT02819518

ENV PROTOCOLOS_PUBLIC=1
EXPOSE 8765
CMD ["sh", "-c", "python -m scripts.prewarm --if-missing --drafts NCT03409614 NCT02578680 NCT03088540 NCT02819518; exec python -m trialforge.demo_guard"]
