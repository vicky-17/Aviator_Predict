FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY cloud_collector.js ./

CMD ["node", "cloud_collector.js"]