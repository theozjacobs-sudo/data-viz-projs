# Hosted copy of the full app (upload + scan), e.g. on Railway, Fly.io or Render.
# Set ANTHROPIC_API_KEY and APP_PASSWORD in the host's environment; mount a volume at /data.
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
ENV INFLUENCE_DB=/data/library.db
VOLUME ["/data"]
EXPOSE 8000
CMD ["sh", "-c", "mkdir -p /data && cd /app && python -m influence_map serve --db ${INFLUENCE_DB} --host 0.0.0.0 --port ${PORT:-8000}"]
