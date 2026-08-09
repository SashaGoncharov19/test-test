FROM oven/bun AS base
WORKDIR /usr/src/app

COPY --chown=bun:bun . .

# Ensure the data directory exists and has correct permissions
RUN mkdir -p /usr/src/app/data && chown -R bun:bun /usr/src/app/data

USER bun
ENTRYPOINT [ "bun", "server.js" ]