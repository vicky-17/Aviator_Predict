FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

RUN npx playwright install chromium --with-deps

COPY cloud_collector.js ./

CMD ["node", "cloud_collector.js"]