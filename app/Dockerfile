# ===== 阶段1：构建阶段 =====
FROM node:18-alpine AS builder
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm install --only=production && npm cache clean --force
COPY . .

# ===== 阶段2：运行阶段（最终镜像）=====
FROM node:18-alpine
WORKDIR /usr/src/app

# 安装curl，供健康检查使用
RUN apk add --no-cache curl

# 只拷贝构建阶段的产物
COPY --from=builder /usr/src/app/node_modules ./node_modules
COPY --from=builder /usr/src/app/package.json ./
COPY --from=builder /usr/src/app/server.js ./
COPY --from=builder /usr/src/app/views ./views

# 使用非root用户运行
USER node

EXPOSE 3000
CMD ["node", "server.js"]
