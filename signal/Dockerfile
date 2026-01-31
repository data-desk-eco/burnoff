FROM node:22-alpine
WORKDIR /app
COPY server.js .
COPY package.json .
RUN npm install --omit=dev
EXPOSE 8080
ENV PORT=8080
CMD ["node", "server.js"]
