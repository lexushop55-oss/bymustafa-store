FROM node:20-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY index.js ./
ENV SESSIONS_DIR=/data/sessions
VOLUME /data
EXPOSE 8787
CMD ["node", "index.js"]
