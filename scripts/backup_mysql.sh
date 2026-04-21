#!/bin/bash
# MySQL自动备份脚本，每天凌晨2点执行，保留最近7天备份

# ========== 配置 ==========
BACKUP_DIR="/home/zqq/my-blog/backups"
MYSQL_CONTAINER="blog_mysql"
MYSQL_USER="root"
# 从.env文件读取MySQL密码，避免硬编码
source /home/zqq/my-blog/.env
MYSQL_PASSWORD="$MYSQL_ROOT_PASSWORD"
DATABASE="$MYSQL_DATABASE"
RETAIN_DAYS=7

# ========== 执行备份 ==========
mkdir -p "$BACKUP_DIR"
DATE=$(date +%Y%m%d_%H%M%S)
FILENAME="${DATABASE}_${DATE}.sql.gz"

# 在容器内执行mysqldump，输出到宿主机并压缩
docker exec "$MYSQL_CONTAINER" mysqldump \
  -u"$MYSQL_USER" \
  -p"$MYSQL_PASSWORD" \
  "$DATABASE" | gzip > "$BACKUP_DIR/$FILENAME"

# 检查备份是否成功
if [ $? -eq 0 ]; then
  echo "[$(date)] ✅ 备份成功: $FILENAME" >> "$BACKUP_DIR/backup.log"
else
  echo "[$(date)] ❌ 备份失败!" >> "$BACKUP_DIR/backup.log"
fi

# 删除超过RETAIN_DAYS天的旧备份
find "$BACKUP_DIR" -name "${DATABASE}_*.sql.gz" -mtime +$RETAIN_DAYS -delete
echo "[$(date)] 已清理${RETAIN_DAYS}天前的旧备份" >> "$BACKUP_DIR/backup.log"
