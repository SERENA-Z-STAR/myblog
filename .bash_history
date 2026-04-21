curl https://www.baidu.com
ip a
sudo cp /etc/apt/sources.list /etc/apt/sources.list.backup
sudo -i
sudo -i
li
ls
cd my-log
cd root
cd /
cd root
sudo -i
cd ~/my-blog‘
cd ~/my-blog
sudo docker-compose up --build
sudo tee /etc/docker/daemon.json <<-'EOF'
{
  "registry-mirrors": ["https://c2gg0od4gq9bbmswjy.xuanyuan.run“
}
EOF

sudo systemctl daemon-reload
sudo systemctl restart docker
docker info
sudo tee /etc/docker/daemon.json <<-'EOF'
{
  "registry-mirrors": ["https://c2gg0od4gq9bbmswjy.xuanyuan.run"]
}
EOF

sudo systemctl daemon-reload
sudo systemctl restart docker
sudo systemctl status docker
sudo docker info
sudo docker-compose up --build
sudo docker-compose restart app
sudo docker-compose down
sudo docker-compose up -d
sudo docker-compose logs -f app
ip a
sudo apt install lrzsz -y
tar -zcvf my-blog.tar.gz ~/my-blog
cd ~/my-blog
sudo dockercompose down -v
sudo docker-compose down -v
sudo rm -rf ./mysql-data ./redis-data
mkdir -p mysql-data redis-data
tee docker-compose.yml <<-'EOF'
version: '3.8'

services:
  # MySQL数据库
  db:
    image: mysql:8.0
    container_name: blog_mysql
    environment:
      MYSQL_ROOT_PASSWORD: root1234
      MYSQL_DATABASE: my_blog
      MYSQL_ROOT_HOST: '%' # 关键：允许root用户从容器远程访问，解决连接拒绝问题
    volumes:
      - ./mysql-data:/var/lib/mysql
    networks:
      - blog-net
    restart: always
    # 健康检查：确认MySQL真的就绪了
    healthcheck:
      test: ["CMD", "mysqladmin", "ping", "-h", "localhost", "-uroot", "-proot1234"]
      interval: 3s
      timeout: 5s
      retries: 10

  # Redis缓存
  redis:
    image: redis:alpine
    container_name: blog_redis
    volumes:
      - ./redis-data:/data
    networks:
      - blog-net
    restart: always
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 3s
      timeout: 5s
      retries: 5

  # Node.js后端服务
  app:
    build: ./app
    container_name: blog_app
    depends_on:
      # 等待MySQL、Redis完全健康，再启动后端
      db:
        condition: service_healthy
      redis:
        condition: service_healthy
    networks:
      - blog-net
    restart: always

  # Nginx反向代理
  nginx:
    image: nginx:alpine
    container_name: blog_nginx
    ports:
      - "8080:80"
    volumes:
      - ./nginx/default.conf:/etc/nginx/conf.d/default.conf
    depends_on:
      - app
    networks:
      - blog-net
    restart: always

networks:
  blog-net:
    driver: bridge
EOF

tee app/server.js <<-'EOF'
const express = require('express');
const mysql = require('mysql2/promise');
const redis = require('redis');
const bodyParser = require('body-parser');
const app = express();
const port = 3000;

// 配置模板引擎
app.set('view engine', 'ejs');
app.use(bodyParser.urlencoded({ extended: true }));

// 1. MySQL连接（带10次重试）
let pool;
async function initMySQL() {
  const maxRetries = 10;
  let retries = 0;
  while (retries < maxRetries) {
    try {
      pool = mysql.createPool({
        host: 'db', // 固定用服务名db，不要用IP！容器IP会变
        user: 'root',
        password: 'root1234',
        database: 'my_blog',
        waitForConnections: true,
        connectionLimit: 10,
      });
      // 测试连接
      await pool.query('SELECT 1');
      console.log('✅ MySQL连接成功！');
      return;
    } catch (e) {
      retries++;
      console.log(`⚠️ MySQL连接失败，重试 ${retries}/${maxRetries}，错误：${e.message}`);
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }
  throw new Error('MySQL连接失败，超过最大重试次数');
}

// 2. Redis连接（带10次重试）
let redisClient;
async function initRedis() {
  const maxRetries = 10;
  let retries = 0;
  while (retries < maxRetries) {
    try {
      redisClient = redis.createClient({ url: 'redis://redis:6379' });
      redisClient.on('error', (err) => console.log('Redis连接错误:', err));
      await redisClient.connect();
      console.log('✅ Redis连接成功！');
      return;
    } catch (e) {
      retries++;
      console.log(`⚠️ Redis连接失败，重试 ${retries}/${maxRetries}，错误：${e.message}`);
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }
  throw new Error('Redis连接失败，超过最大重试次数');
}

// 3. 初始化数据库表
async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS articles (
        id INT AUTO_INCREMENT PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        content TEXT NOT NULL,
        view_count INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    // 插入测试文章
    await pool.query(`
      INSERT IGNORE INTO articles (id, title, content) 
      VALUES (1, '我的第一篇博客', 'Hello World！这是从MySQL数据库中读取的内容，Redis已经准备好加速你的访问啦~')
    `);
    console.log('✅ 数据库表初始化完成');
  } catch (e) {
    console.error('❌ 数据库初始化失败:', e);
  }
}

// --- API接口 ---
// 首页
app.get('/', async (req, res) => {
  try {
    const cacheKey = 'home_article_list';
    let cacheData = await redisClient.get(cacheKey);

    if (cacheData) {
      console.log('✅ 命中Redis缓存');
      res.render('index', { articles: JSON.parse(cacheData) });
    } else {
      console.log('⚠️ 查询MySQL');
      const [articles] = await pool.query('SELECT * FROM articles ORDER BY id DESC');
      await redisClient.setEx(cacheKey, 60, JSON.stringify(articles));
      res.render('index', { articles });
    }
  } catch (e) {
    console.error('首页错误:', e);
    res.status(500).send('服务器错误');
  }
});

// 文章详情页
app.get('/article/:id', async (req, res) => {
  try {
    const articleId = req.params.id;
    await pool.query('UPDATE articles SET view_count = view_count + 1 WHERE id = ?', [articleId]);
    const [rows] = await pool.query('SELECT * FROM articles WHERE id = ?', [articleId]);
    if (rows.length === 0) return res.status(404).send('文章不存在');
    
    const viewerKey = `article_viewer:${articleId}:${req.ip}`;
    const isNewViewer = await redisClient.setNX(viewerKey, '1');
    if (isNewViewer) await redisClient.expire(viewerKey, 86400);

    res.render('article', { article: rows[0], isNewViewer });
  } catch (e) {
    console.error('文章详情错误:', e);
    res.status(500).send('服务器错误');
  }
});

// 发布文章
app.post('/publish', async (req, res) => {
  try {
    const { title, content } = req.body;
    await pool.query('INSERT INTO articles (title, content) VALUES (?, ?)', [title, content]);
    await redisClient.del('home_article_list');
    res.redirect('/');
  } catch (e) {
    console.error('发布文章错误:', e);
    res.status(500).send('发布失败');
  }
});

// 启动服务
async function startServer() {
  try {
    await initMySQL();
    await initRedis();
    await initDB();
    app.listen(port, () => {
      console.log(`🎉 博客后端服务启动成功，端口: ${port}`);
    });
  } catch (e) {
    console.error('❌ 服务启动失败:', e);
    process.exit(1);
  }
}

startServer();
EOF

sudo docker-compose up --build
tar -zcvf my-blog-full.tar.gz /home/zqq/my-blog
sudo -i
sudo docker-compose up -d --build
docker-compose logs -f app
sudo docker-compose down
