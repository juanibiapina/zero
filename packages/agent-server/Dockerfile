FROM node:22-bookworm-slim

WORKDIR /app

COPY dist/ ./dist/

EXPOSE 8080

CMD ["node", "dist/index.js"]
