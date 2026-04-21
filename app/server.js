// 【关键】加载.env文件，必须放在第一行
require('dotenv').config();

const express = require('express');
const mysql = require('mysql2/promise');
const redis = require('redis');
const bodyParser = require('body-parser');
const app = express();

// ========== 配置 ==========
const port = process.env.APP_PORT || 3000;
const mysqlConfig = {
  host: 'db',
  user: 'root',
  password: process.env.MYSQL_ROOT_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  waitForConnections: true,
  connectionLimit: 10,
};
const redisUrl = process.env.REDIS_URL || 'redis://redis:6379';

app.set('view engine', 'ejs');
app.use(bodyParser.urlencoded({ extended: true }));

// ========== 数据库连接 ==========
let pool;
async function initMySQL() {
  const maxRetries = 10;
  for (let i = 1; i <= maxRetries; i++) {
    try {
      pool = mysql.createPool(mysqlConfig);
      await pool.query('SELECT 1');
      console.log('[DB] MySQL 连接成功');
      return;
    } catch (e) {
      console.log(`[DB] MySQL 连接失败，重试 ${i}/${maxRetries}: ${e.message}`);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
  throw new Error('MySQL 连接失败，超过最大重试次数');
}

let redisClient;
async function initRedis() {
  const maxRetries = 10;
  for (let i = 1; i <= maxRetries; i++) {
    try {
      redisClient = redis.createClient({ url: redisUrl });
      redisClient.on('error', (err) => console.error('[Redis] 错误:', err.message));
      await redisClient.connect();
      console.log('[Redis] 连接成功');
      return;
    } catch (e) {
      console.log(`[Redis] 连接失败，重试 ${i}/${maxRetries}: ${e.message}`);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
  throw new Error('Redis 连接失败，超过最大重试次数');
}

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
    await pool.query(`
      INSERT IGNORE INTO articles (id, title, content) 
      VALUES (1, '我的第一篇博客', 'Hello World！这是从MySQL数据库中读取的内容，Redis已经准备好加速你的访问啦~')
    `);
    console.log('[DB] 表初始化完成');
  } catch (e) {
    console.error('[DB] 初始化失败:', e.message);
  }
}

// ========== 健康检查接口 (核心新增) ==========
app.get('/health', async (req, res) => {
  const health = {
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    checks: {}
  };

  // 检查 MySQL 连通性
  try {
    await pool.query('SELECT 1');
    health.checks.mysql = { status: 'up' };
  } catch (e) {
    health.checks.mysql = { status: 'down', error: e.message };
    health.status = 'degraded';
  }

  // 检查 Redis 连通性
  try {
    await redisClient.ping();
    health.checks.redis = { status: 'up' };
  } catch (e) {
    health.checks.redis = { status: 'down', error: e.message };
    health.status = 'degraded';
  }

  const code = health.status === 'ok' ? 200 : 503;
  res.status(code).json(health);
});

// ========== 业务接口 ==========
app.get('/', async (req, res) => {
  try {
    const cacheKey = 'home_article_list';
    const cacheData = await redisClient.get(cacheKey);

    if (cacheData) {
      console.log('[Cache] 命中 Redis 缓存');
      res.render('index', { articles: JSON.parse(cacheData) });
    } else {
      console.log('[Cache] 未命中，查询 MySQL');
      const [articles] = await pool.query('SELECT * FROM articles ORDER BY id DESC');
      await redisClient.setEx(cacheKey, 60, JSON.stringify(articles));
      res.render('index', { articles });
    }
  } catch (e) {
    console.error('[App] 首页错误:', e.message);
    res.status(500).send('服务器错误');
  }
});

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
    console.error('[App] 文章详情错误:', e.message);
    res.status(500).send('服务器错误');
  }
});

app.post('/publish', async (req, res) => {
  try {
    const { title, content } = req.body;
    if (!title || !content) return res.status(400).send('标题和内容不能为空');
    await pool.query('INSERT INTO articles (title, content) VALUES (?, ?)', [title, content]);
    await redisClient.del('home_article_list');
    console.log(`[App] 新文章发布: ${title}`);
    res.redirect('/');
  } catch (e) {
    console.error('[App] 发布文章错误:', e.message);
    res.status(500).send('发布失败');
  }
});

// ========== 优雅关闭 (核心新增) ==========
const server = app.listen(port, '0.0.0.0', () => {
  console.log(`[App] 服务启动成功，端口: ${port}`);
});

// 信号处理：收到 SIGTERM/SIGINT 时优雅关闭
async function gracefulShutdown(signal) {
  console.log(`\n[App] 收到 ${signal}，开始优雅关闭...`);
  
  // 1. 停止接收新请求
  server.close(() => {
    console.log('[App] HTTP 服务器已停止接收新请求');
  });

  // 2. 关闭数据库连接
  try {
    await redisClient.quit();
    console.log('[Redis] 连接已安全关闭');
    await pool.end();
    console.log('[MySQL] 连接池已安全关闭');
  } catch (e) {
    console.error('[App] 关闭连接时出错:', e.message);
  }

  console.log('[App] 优雅关闭完成，再见！');
  process.exit(0);
}

// 监听终止信号
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ========== 启动 ==========
async function startServer() {
  try {
    await initMySQL();
    await initRedis();
    await initDB();
  } catch (e) {
    console.error('[App] 启动失败:', e.message);
    process.exit(1);
  }
}

startServer();
