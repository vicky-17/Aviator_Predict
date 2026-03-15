FROM mcr.microsoft.com/playwright:v1.42.0-jammy

WORKDIR /app

COPY package.json package-lock.json* ./

RUN npm install --omit=dev

COPY cloud_collector.js ./

RUN npx playwright install chromium

CMD ["node", "cloud_collector.js"]