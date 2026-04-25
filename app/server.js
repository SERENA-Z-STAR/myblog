require("dotenv").config();
const express = require("express");
const mysql = require("mysql2/promise");
const redis = require("redis");
const bodyParser = require("body-parser");
const crypto = require("crypto");
const session = require("express-session");
const rateLimit = require("express-rate-limit");
const helmet = require("helmet");
const { body, validationResult } = require("express-validator");
const app = express();

app.use(helmet());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.set("view engine", "ejs");
app.set("trust proxy", 1);

app.use(
  session({
    secret:
      process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex"),
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: false,
      httpOnly: true,
      maxAge: 24 * 60 * 60 * 1000,
    },
  }),
);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: "登录尝试次数过多，请15分钟后再试" },
});

const publishLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: "发布频率过快，请稍后再试" },
});

function generateToken() {
  return crypto.randomBytes(32).toString("hex");
}

function hashPassword(password, salt) {
  return crypto
    .pbkdf2Sync(password, salt, 100000, 64, "sha512")
    .toString("hex");
}

function isAuthenticated(req) {
  return req.session.userId !== undefined;
}

function escapeHtml(str) {
  if (typeof str !== "string") return str;
  const map = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#x27;",
  };
  return str.replace(/[&<>"']/g, (char) => map[char]);
}

const port = process.env.APP_PORT || 3000;
const mysqlConfig = {
  host: "db",
  user: "root",
  password: process.env.MYSQL_ROOT_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  waitForConnections: true,
  connectionLimit: 10,
};
const redisUrl = process.env.REDIS_URL || "redis://redis:6379";

let pool;
async function initMySQL() {
  const maxRetries = 10;
  for (let i = 1; i <= maxRetries; i++) {
    try {
      pool = mysql.createPool(mysqlConfig);
      await pool.query("SELECT 1");
      console.log("[DB] MySQL 连接成功");
      return;
    } catch (e) {
      console.log(`[DB] MySQL 连接失败，重试 ${i}/${maxRetries}: ${e.message}`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  throw new Error("MySQL 连接失败，超过最大重试次数");
}

let redisClient;
async function initRedis() {
  const maxRetries = 10;
  for (let i = 1; i <= maxRetries; i++) {
    try {
      redisClient = redis.createClient({ url: redisUrl });
      redisClient.on("error", (err) =>
        console.error("[Redis] 错误:", err.message),
      );
      await redisClient.connect();
      console.log("[Redis] 连接成功");
      return;
    } catch (e) {
      console.log(`[Redis] 连接失败，重试 ${i}/${maxRetries}: ${e.message}`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  throw new Error("Redis 连接失败，超过最大重试次数");
}

async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        password VARCHAR(128) NOT NULL,
        salt VARCHAR(32) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS articles (
        id INT AUTO_INCREMENT PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        content TEXT NOT NULL,
        author_id INT NOT NULL,
        view_count INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (author_id) REFERENCES users(id)
      )
    `);
    await pool.query(`
      INSERT IGNORE INTO articles (id, title, content, author_id)
      VALUES (1, '我的第一篇博客', 'Hello World！这是从MySQL数据库中读取的内容，Redis已经准备好加速你的访问啦~', 1)
    `);
    console.log("[DB] 表初始化完成");
  } catch (e) {
    console.error("[DB] 初始化失败:", e.message);
  }
}

app.get("/health", async (req, res) => {
  const health = {
    status: "ok",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    checks: {},
  };

  try {
    await pool.query("SELECT 1");
    health.checks.mysql = { status: "up" };
  } catch (e) {
    health.checks.mysql = { status: "down", error: e.message };
    health.status = "degraded";
  }

  try {
    await redisClient.ping();
    health.checks.redis = { status: "up" };
  } catch (e) {
    health.checks.redis = { status: "down", error: e.message };
    health.status = "degraded";
  }

  const code = health.status === "ok" ? 200 : 503;
  res.status(code).json(health);
});

app.get("/register", (req, res) => {
  res.render("register", { error: null, username: "" });
});

app.post(
  "/register",
  authLimiter,
  [
    body("username")
      .trim()
      .isLength({ min: 3, max: 20 })
      .withMessage("用户名需要3-20个字符"),
    body("password").isLength({ min: 6 }).withMessage("密码至少6个字符"),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.render("register", {
        error: errors.array()[0].msg,
        username: req.body.username,
      });
    }

    try {
      const { username, password } = req.body;
      const salt = crypto.randomBytes(16).toString("hex");
      const hashedPassword = hashPassword(password, salt);

      await pool.query(
        "INSERT INTO users (username, password, salt) VALUES (?, ?, ?)",
        [username, hashedPassword, salt],
      );
      res.redirect("/login");
    } catch (e) {
      if (e.code === "ER_DUP_ENTRY") {
        res.render("register", {
          error: "用户名已存在",
          username: req.body.username,
        });
      } else {
        console.error("[App] 注册错误:", e.message);
        res.render("register", {
          error: "注册失败",
          username: req.body.username,
        });
      }
    }
  },
);

app.get("/login", (req, res) => {
  if (isAuthenticated(req)) {
    return res.redirect("/");
  }
  res.render("login", { error: null, username: "" });
});

app.post(
  "/login",
  authLimiter,
  [body("username").trim().notEmpty(), body("password").notEmpty()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.render("login", {
        error: "用户名和密码不能为空",
        username: req.body.username,
      });
    }

    try {
      const { username, password } = req.body;
      const [users] = await pool.query(
        "SELECT * FROM users WHERE username = ?",
        [username],
      );

      if (users.length === 0) {
        return res.render("login", { error: "用户名或密码错误", username });
      }

      const user = users[0];
      const hashedPassword = hashPassword(password, user.salt);

      if (hashedPassword !== user.password) {
        return res.render("login", { error: "用户名或密码错误", username });
      }

      req.session.userId = user.id;
      req.session.username = user.username;
      res.redirect("/");
    } catch (e) {
      console.error("[App] 登录错误:", e.message);
      res.render("login", { error: "登录失败", username: req.body.username });
    }
  },
);

app.get("/logout", (req, res) => {
  req.session.destroy();
  res.redirect("/login");
});

app.get("/", async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const perPage = 10;
    const offset = (page - 1) * perPage;

    const cacheKey = `home_article_list:page:${page}`;
    const cacheData = await redisClient.get(cacheKey);

    let articles,
      totalCount,
      totalArticles,
      totalViews,
      totalUsers,
      recentArticles;

    if (cacheData) {
      const cached = JSON.parse(cacheData);
      articles = cached.articles;
      totalCount = cached.totalCount;
      totalArticles = cached.totalArticles;
      totalViews = cached.totalViews;
      totalUsers = cached.totalUsers;
      recentArticles = cached.recentArticles;
    } else {
      [articles] = await pool.query(
        `
        SELECT a.*, u.username as author_name
        FROM articles a
        LEFT JOIN users u ON a.author_id = u.id
        ORDER BY a.id DESC
        LIMIT ? OFFSET ?
      `,
        [perPage, offset],
      );

      [[{ total }]] = await pool.query(
        "SELECT COUNT(*) as total FROM articles",
      );
      totalCount = total;

      // 获取统计数据
      [[{ total: totalArticles }]] = await pool.query(
        "SELECT COUNT(*) as total FROM articles",
      );
      [[{ total: totalViews }]] = await pool.query(
        "SELECT SUM(view_count) as total FROM articles",
      );
      [[{ total: totalUsers }]] = await pool.query(
        "SELECT COUNT(*) as total FROM users",
      );

      // 获取最新文章
      [recentArticles] = await pool.query(
        `
        SELECT a.id, a.title
        FROM articles a
        ORDER BY a.id DESC
        LIMIT 5
      `,
      );

      await redisClient.setEx(
        cacheKey,
        60,
        JSON.stringify({
          articles,
          totalCount,
          totalArticles,
          totalViews,
          totalUsers,
          recentArticles,
        }),
      );
    }

    const totalPages = Math.ceil(totalCount / perPage);
    res.render("index", {
      articles,
      currentPage: page,
      totalPages,
      isAuthenticated: isAuthenticated(req),
      username: req.session.username,
      userId: req.session.userId,
      totalArticles,
      totalViews,
      totalUsers,
      recentArticles,
    });
  } catch (e) {
    console.error("[App] 首页错误:", e.message);
    res.status(500).send("服务器错误");
  }
});

app.get("/article/:id", async (req, res) => {
  try {
    const articleId = req.params.id;
    await pool.query(
      "UPDATE articles SET view_count = view_count + 1 WHERE id = ?",
      [articleId],
    );
    const [rows] = await pool.query(
      `
      SELECT a.*, u.username as author_name
      FROM articles a
      LEFT JOIN users u ON a.author_id = u.id
      WHERE a.id = ?
    `,
      [articleId],
    );

    if (rows.length === 0) return res.status(404).send("文章不存在");

    const viewerKey = `article_viewer:${articleId}:${req.ip}`;
    const isNewViewer = await redisClient.setNX(viewerKey, "1");
    if (isNewViewer) await redisClient.expire(viewerKey, 86400);

    const isOwner =
      isAuthenticated(req) && req.session.userId === rows[0].author_id;

    res.render("article", {
      article: rows[0],
      isNewViewer,
      isAuthenticated: isAuthenticated(req),
      isOwner,
      username: req.session.username,
    });
  } catch (e) {
    console.error("[App] 文章详情错误:", e.message);
    res.status(500).send("服务器错误");
  }
});

app.get("/edit/:id", async (req, res) => {
  if (!isAuthenticated(req)) {
    return res.redirect("/login");
  }

  try {
    const articleId = req.params.id;
    const [rows] = await pool.query("SELECT * FROM articles WHERE id = ?", [
      articleId,
    ]);

    if (rows.length === 0) return res.status(404).send("文章不存在");
    if (rows[0].author_id !== req.session.userId) {
      return res.status(403).send("没有权限编辑此文章");
    }

    res.render("edit", { article: rows[0], error: null });
  } catch (e) {
    console.error("[App] 编辑页面错误:", e.message);
    res.status(500).send("服务器错误");
  }
});

app.post("/edit/:id", async (req, res) => {
  if (!isAuthenticated(req)) {
    return res.redirect("/login");
  }

  try {
    const articleId = req.params.id;
    const { title, content } = req.body;

    if (!title || !content) {
      const [rows] = await pool.query("SELECT * FROM articles WHERE id = ?", [
        articleId,
      ]);
      return res.render("edit", {
        article: rows[0],
        error: "标题和内容不能为空",
      });
    }

    const [rows] = await pool.query("SELECT * FROM articles WHERE id = ?", [
      articleId,
    ]);
    if (rows.length === 0) return res.status(404).send("文章不存在");
    if (rows[0].author_id !== req.session.userId) {
      return res.status(403).send("没有权限编辑此文章");
    }

    await pool.query(
      "UPDATE articles SET title = ?, content = ? WHERE id = ?",
      [title, content, articleId],
    );

    const keys = await redisClient.keys("home_article_list:*");
    if (keys.length > 0) await redisClient.del(keys);

    res.redirect(`/article/${articleId}`);
  } catch (e) {
    console.error("[App] 编辑文章错误:", e.message);
    res.status(500).send("编辑失败");
  }
});

app.post("/delete/:id", async (req, res) => {
  if (!isAuthenticated(req)) {
    return res.redirect("/login");
  }

  try {
    const articleId = req.params.id;
    const [rows] = await pool.query("SELECT * FROM articles WHERE id = ?", [
      articleId,
    ]);

    if (rows.length === 0) return res.status(404).send("文章不存在");
    if (rows[0].author_id !== req.session.userId) {
      return res.status(403).send("没有权限删除此文章");
    }

    await pool.query("DELETE FROM articles WHERE id = ?", [articleId]);

    const keys = await redisClient.keys("home_article_list:*");
    if (keys.length > 0) await redisClient.del(keys);

    res.redirect("/");
  } catch (e) {
    console.error("[App] 删除文章错误:", e.message);
    res.status(500).send("删除失败");
  }
});

app.post(
  "/publish",
  publishLimiter,
  [
    body("title")
      .trim()
      .isLength({ min: 1, max: 255 })
      .withMessage("标题不能为空且不超过255字符"),
    body("content").trim().isLength({ min: 1 }).withMessage("内容不能为空"),
  ],
  async (req, res) => {
    if (!isAuthenticated(req)) {
      return res.redirect("/login");
    }

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg });
    }

    try {
      const { title, content } = req.body;
      await pool.query(
        "INSERT INTO articles (title, content, author_id) VALUES (?, ?, ?)",
        [title, content, req.session.userId],
      );

      const keys = await redisClient.keys("home_article_list:*");
      if (keys.length > 0) await redisClient.del(keys);

      console.log(`[App] 新文章发布: ${title} by ${req.session.username}`);
      res.redirect("/");
    } catch (e) {
      console.error("[App] 发布文章错误:", e.message);
      res.status(500).json({ error: "发布失败" });
    }
  },
);

const server = app.listen(port, "0.0.0.0", () => {
  console.log(`[App] 服务启动成功，端口: ${port}`);
});

async function gracefulShutdown(signal) {
  console.log(`\n[App] 收到 ${signal}，开始优雅关闭...`);

  server.close(() => {
    console.log("[App] HTTP 服务器已停止接收新请求");
  });

  try {
    await redisClient.quit();
    console.log("[Redis] 连接已安全关闭");
    await pool.end();
    console.log("[MySQL] 连接池已安全关闭");
  } catch (e) {
    console.error("[App] 关闭连接时出错:", e.message);
  }

  console.log("[App] 优雅关闭完成，再见！");
  process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

async function startServer() {
  try {
    await initMySQL();
    await initRedis();
    await initDB();
  } catch (e) {
    console.error("[App] 启动失败:", e.message);
    process.exit(1);
  }
}

startServer();
