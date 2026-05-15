FROM node:20-alpine

WORKDIR /app

COPY package.json ./
COPY leveldb-mcpe-1.0.1.tgz ./
RUN apk add --no-cache python3 make g++ && npm install --omit=dev

COPY server.js ./
COPY index.html ./

EXPOSE 3000

CMD ["node", "server.js"]
