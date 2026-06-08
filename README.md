# 客服台失物招领系统 · 云端免费版（随处共享）

把后端部署到云端,得到一个固定网址。任何人、任何网络、任何地方,扫码或打开链接即可用,数据全部存在云端、人人实时共享。后台密码固定内置(服务器端校验,前端拿不到、改不了)。

- 后端托管:**Render** 免费 Web 服务(无需信用卡;闲置 15 分钟休眠,再打开冷启动约 30–60 秒)
- 数据库:**Neon** 免费 Postgres(0.5 GB、永不过期、可商用)——失物招领是文字,完全够用
- 全程在**手机浏览器**即可完成,无需电脑、无需命令行

---

## 第 1 步：建免费数据库（Neon）

1. 手机浏览器打开 **neon.com**,用邮箱或 Google 注册(免信用卡)。
2. 新建一个 Project（名字随意，区域选离你近的，如 Singapore）。
3. 进项目后找到 **Connection string / 连接串**,复制那串以 `postgresql://...` 开头的地址。这就是稍后要用的 `DATABASE_URL`，先存到备忘录。

## 第 2 步：把代码放到 GitHub

1. 浏览器打开 **github.com** 注册/登录。
2. 右上角 **+ → New repository**，名字如 `laf-cloud`，选 **Public**，创建。
3. 在仓库页点 **Add file → Upload files**，把本项目里这几个文件全部上传到**根目录**：
   - `server.js`
   - `package.json`
   - `index.html`
   - `.gitignore`（可选）
   （手机上可一次多选；不要建子文件夹，全放最外层。）
4. 下方点 **Commit changes** 提交。

## 第 3 步：在 Render 上线

1. 浏览器打开 **render.com**，用 GitHub 账号登录（免信用卡）。
2. **New + → Web Service → Connect** 你刚建的 `laf-cloud` 仓库。
3. 关键设置：
   - Language：**Node**
   - Build Command：`npm install`
   - Start Command：`npm start`
   - Instance Type：选 **Free**
4. 展开 **Environment / 环境变量**，添加两条：
   - `DATABASE_URL` = 第 1 步复制的 Neon 连接串
   - `JWT_SECRET` = 一长串随机字符（手机上可用任意随机密码生成器生成 40+ 位，或随手敲一长串字母数字）
5. 点 **Create Web Service**，等几分钟构建完成。Render 会给你一个固定网址，形如 `https://laf-cloud-xxxx.onrender.com`。

打开这个网址就是系统首页了。后台密码用你设定的固定密码登录。

## 第 4 步：生成二维码对外张贴

用上面拿到的 Render 网址打开 → 进**客服后台** → **二维码/海报** → 生成二维码 / 打印海报。这个网址全国任何网络都能访问，顾客扫码即用。

---

## 使用与维护

- **共享**：所有人访问同一个 Render 网址，数据都在 Neon 里，实时共享、永久保存。
- **冷启动**：免费层闲置 15 分钟后休眠，下一次有人打开会等约 30–60 秒（这是免费方案的代价，可接受）。要彻底免休眠，可日后把 Render 实例升到 $7/月。
- **数据安全**：后台密码经 scrypt 哈希在服务器校验，前端永远拿不到，改前端代码也没用；公众接口不下发核验特征与顾客个人信息。
- **备份**：数据在 Neon 云端持久保存；Neon 控制台可导出。也可登录后台用导出功能（如已启用）留底。

## 想换后台密码？

本地或任意能运行 Node 的地方执行下面命令，生成新哈希：
```
node -e "const c=require('crypto');const s=c.randomBytes(16);console.log(s.toString('hex')+':'+c.scryptSync('你的新密码',s,64).toString('hex'))"
```
把输出填到 Render 环境变量 `ADMIN_PASS_HASH`，保存后服务会自动重启生效。

## 本地试运行（可选）
```
npm install
# 设置环境变量后启动
DATABASE_URL="你的neon连接串" JWT_SECRET="随机串" npm start
# 打开 http://localhost:3000
```
