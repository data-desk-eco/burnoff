FROM node:22-alpine
WORKDIR /app
COPY signal-server.js .
COPY package.json .
RUN npm install --omit=dev
EXPOSE 8080
ENV PORT=8080
CMD ["node", "signal-server.js"]
