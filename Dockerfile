FROM oven/bun AS base
WORKDIR /usr/src/app

COPY . .

USER bun
ENTRYPOINT [ "bun", "server.js" ]
