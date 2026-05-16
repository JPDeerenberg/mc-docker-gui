FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache python3 make g++ zlib-dev snappy-dev snappy
COPY package*.json leveldb-mcpe-1.0.1.tgz ./
RUN npm install --omit=dev

COPY server.js ./
COPY index.html ./

EXPOSE 3000

CMD ["node", "server.js"]
