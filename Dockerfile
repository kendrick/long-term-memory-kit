FROM --platform=linux/amd64 debian:trixie-slim
ARG LTM_VERSION
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git && rm -rf /var/lib/apt/lists/*
COPY bin/ltm-fetch.sh /tmp/ltm-fetch.sh
RUN test -n "$LTM_VERSION" || { echo "ltm: pass --build-arg LTM_VERSION=vX.Y.Z" >&2; exit 1; }; . /tmp/ltm-fetch.sh && ltm_fetch "$LTM_VERSION" /usr/local/bin/ltm && rm /tmp/ltm-fetch.sh
RUN useradd --system --create-home --home-dir /var/lib/ltm ltm
USER ltm
ENV LTM_DATA_DIR=/var/lib/ltm
EXPOSE 8080
ENTRYPOINT ["ltm", "mcp", "--http", "0.0.0.0:8080"]
