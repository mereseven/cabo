# CABO 联机版 - 单容器镜像（含前端静态文件 + socket.io 服务端）
FROM node:22-alpine

WORKDIR /app

# 先装依赖，利用层缓存
COPY package.json package-lock.json ./
RUN npm ci

# 再拷贝源码并构建前端
COPY . .
RUN npm run build

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

# 直接用 tsx 跑 TypeScript 服务端（tsx 是生产依赖）
CMD ["npm", "start"]
