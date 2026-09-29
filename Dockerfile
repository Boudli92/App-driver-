# Private Driver Club — image de production (aucune dépendance npm à l'exécution)
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3000 DATABASE_PATH=/data/pdc.sqlite
COPY package.json tsconfig.json ./
COPY src ./src
COPY public ./public
RUN addgroup -S app && adduser -S app -G app && mkdir -p /data && chown app:app /data
USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--experimental-strip-types", "--disable-warning=ExperimentalWarning", "src/server.ts"]
