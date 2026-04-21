const mysql = require("mysql2/promise");
require("dotenv").config();

const mysqlConfig = {
  host: process.env.DB_HOST || "localhost",
  user: "root",
  password: process.env.MYSQL_ROOT_PASSWORD,
  database: process.env.MYSQL_DATABASE,
};

const defaultUsername = process.env.DEFAULT_USER || "admin";
const defaultPassword = process.env.DEFAULT_PASSWORD || "admin123";

async function initDefaultUser() {
  let connection;
  try {
    connection = await mysql.createConnection(mysqlConfig);
    console.log("[Init] 数据库连接成功");

    const [existingUsers] = await connection.query(
      "SELECT id FROM users WHERE username = ?",
      [defaultUsername],
    );
    if (existingUsers.length > 0) {
      console.log(`[Init] 默认用户 ${defaultUsername} 已存在`);
      return;
    }

    const crypto = require("crypto");
    const salt = crypto.randomBytes(16).toString("hex");
    const hashedPassword = crypto
      .pbkdf2Sync(defaultPassword, salt, 100000, 64, "sha512")
      .toString("hex");

    await connection.query(
      "INSERT INTO users (username, password, salt) VALUES (?, ?, ?)",
      [defaultUsername, hashedPassword, salt],
    );

    console.log(
      `[Init] 默认用户创建成功: ${defaultUsername} / ${defaultPassword}`,
    );
    console.log("[Init] 请及时修改默认密码！");
  } catch (e) {
    console.error("[Init] 初始化失败:", e.message);
    process.exit(1);
  } finally {
    if (connection) await connection.end();
  }
}

initDefaultUser();
