FROM node:22-bookworm

RUN apt-get update && apt-get install -y git zstd curl gpg && \
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | gpg --dearmor -o /usr/share/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list && \
    apt-get update && apt-get install -y gh && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package.json and strip devDependencies (they use workspace: protocol)
COPY package.json ./
RUN node -e "const p=JSON.parse(require('fs').readFileSync('package.json','utf8')); delete p.devDependencies; require('fs').writeFileSync('package.json',JSON.stringify(p,null,2));"
RUN npm install --omit=dev

COPY dist/ ./dist/

EXPOSE 8080

CMD ["node", "dist/index.js"]
