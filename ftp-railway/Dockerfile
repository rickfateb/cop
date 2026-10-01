FROM node:20-bookworm-slim
WORKDIR /app
COPY server.js /app/server.js
RUN mkdir -p /srv/ftp
EXPOSE 2121 21000
CMD ["node","/app/server.js"]
