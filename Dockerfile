FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssh-server ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .

RUN mkdir -p /run/sshd /data/sftp/incoming /data/sftp/rejected \
  && chmod +x /app/docker/entrypoint.sh

EXPOSE 3000 2222
ENTRYPOINT ["/app/docker/entrypoint.sh"]
