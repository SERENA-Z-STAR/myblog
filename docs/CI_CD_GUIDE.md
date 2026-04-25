# CI/CD 自动化部署指南

## 📋 流程概览

```
┌──────────────┐    push     ┌───────────────┐    trigger    ┌──────────────┐
│   本地代码    │ ─────────> │   GitHub      │ ───────────> │ Docker Hub   │
│   push       │            │   Actions     │              │   镜像仓库   │
└──────────────┘            └───────────────┘              └──────────────┘
                                                                      │
                                                                      │ pull
                                                                      ▼
                                                              ┌──────────────┐
                                                              │   虚拟机     │
                                                              │  Watchtower  │
                                                              │  自动更新     │
                                                              └──────────────┘
```

## 🔧 你需要完成的配置

### 第一步：配置 GitHub Secrets

1. **获取 Docker Hub Token**
   - 登录 Docker Hub：https://hub.docker.com
   - 点击右上角头像 → Account Settings
   - 选择 "Security" → "Access Tokens"
   - 点击 "Generate new token"
   - 输入 Token 名称（如：github-actions）
   - 复制生成的 Token

2. **在 GitHub 仓库添加 Secrets**
   - 打开你的 GitHub 仓库：https://github.com/SERENA-Z-STAR/myblog
   - 点击 "Settings" → "Secrets and variables" → "Actions"
   - 点击 "New repository secret"，添加以下两个：

   | Secret Name | Value |
   |------------|-------|
   | `DOCKERHUB_USERNAME` | 你的 Docker Hub 用户名 |
   | `DOCKERHUB_TOKEN` | 刚才生成的 Docker Hub Access Token |

### 第二步：在虚拟机上登录 Docker Hub

SSH 到你的虚拟机，执行：

```bash
# 登录 Docker Hub（会提示输入用户名和密码）
docker login

# 这会创建 ~/.docker/config.json，Watchtower 需要用到
```

### 第三步：修改 .env 文件

在虚拟机上，修改 `.env` 文件：

```bash
# 修改这一行为你的 Docker Hub 用户名
DOCKERHUB_USERNAME=your_dockerhub_username
```

### 第四步：拉取最新代码并启动

```bash
cd myblog
git pull origin master

# 重新构建并启动所有服务（包括 Watchtower）
docker compose down
docker compose up -d

# 查看服务状态
docker compose ps
```

## 🚀 完整的自动化流程

### 当你本地开发完成后：

1. **本地提交并推送代码**
   ```bash
   git add .
   git commit -m "更新内容"
   git push origin master
   ```

2. **GitHub Actions 自动触发**（大约2-3分钟）
   - 检测到 master 分支有新的 push
   - 自动执行 workflow：
     - 编译 Node.js 应用
     - 构建 Docker 镜像（app、nginx、prometheus）
     - 推送到你的 Docker Hub 仓库

3. **虚拟机上的 Watchtower 自动更新**（最多等待5分钟）
   - Watchtower 每 5 分钟检查一次 Docker Hub
   - 发现新镜像后自动：
     - 拉取新镜像
     - 停止旧容器
     - 启动新容器
     - 清理旧镜像

## 📊 监控和日志

### 查看 Watchtower 日志
```bash
docker logs -f watchtower
```

### 查看所有服务状态
```bash
docker compose ps
```

### 查看某个服务日志
```bash
docker compose logs app
docker compose logs nginx
docker compose logs db
```

## ⚠️ 重要提醒

### 安全建议
1. **不要把 .env 文件提交到 GitHub**（已经在 .gitignore 中）
2. **定期更新 Docker Hub Access Token**
3. **生产环境建议使用私有镜像仓库**

### 故障排查

#### 问题1：GitHub Actions 构建失败
- 检查 Secrets 配置是否正确
- 查看 Actions 日志中的具体错误信息

#### 问题2：Watchtower 没有自动更新
- 确认 Docker Hub 登录成功：`docker login`
- 检查 Watchtower 日志：`docker logs watchtower`
- 手动测试：`docker pull your_username/myblog:app-latest`

#### 问题3：服务启动失败
- 检查 .env 文件配置
- 查看日志：`docker compose logs service_name`
- 确认端口未被占用：`netstat -tlnp | grep 8080`

## 🎯 推荐的开发工作流

1. **本地开发** → 测试通过
2. **Git push** → 自动构建
3. **喝杯咖啡** → 等待自动部署
4. **验证生产环境** → 完成！

## 📝 每次发布的文件

以下文件或目录的更改会自动触发构建：
- `app/**` - 应用代码
- `docker-compose.yml` - Docker 配置
- `.my.cnf` - MySQL 配置
- `nginx/**` - Nginx 配置
- `prometheus/**` - Prometheus 配置

## 🔄 手动更新（不推荐）

如果需要手动更新（在 Watchtower 之前）：

```bash
# SSH 到虚拟机
ssh user@your-vm-ip

# 进入项目目录
cd myblog

# 拉取最新代码
git pull origin master

# 手动拉取新镜像
docker compose pull

# 重启服务
docker compose up -d --force-recreate
```
