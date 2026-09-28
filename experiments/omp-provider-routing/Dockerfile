FROM oven/bun:1.4.2

WORKDIR /worker
COPY experiments/omp-provider-routing/package.json experiments/omp-provider-routing/bun.lock ./
RUN bun install --frozen-lockfile --production
COPY experiments/omp-provider-routing/*.ts ./

USER bun
EXPOSE 17331
CMD ["bun", "run", "live-server.ts"]
