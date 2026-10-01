FROM node:20-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends vsftpd && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY watcher.js /app/watcher.js
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh && mkdir -p /srv/ftp
EXPOSE 21 21000-21010
ENTRYPOINT ["/app/entrypoint.sh"]
