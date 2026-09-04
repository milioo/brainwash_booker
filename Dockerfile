FROM node:22-bookworm
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev && npx playwright install --with-deps chromium
COPY . .
ENV PORT=3000 TZ=Europe/Amsterdam DATA_DIR=/app/data HEADLESS=true BOOKING_ENABLED=false
EXPOSE 3000
CMD ["npm", "start"]
