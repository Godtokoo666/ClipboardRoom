# ClipboardRoom

一个轻量的跨设备云剪切板工具。创建一个 Room 后，其他设备可以通过 32 位 Room 密钥，或一次性二维码加入同一个共享剪切板，实时发送文字、图片和文件。

ClipboardRoom 是一个单服务应用：Express 提供 HTTP API 和静态页面，WebSocket 负责实时同步，前端使用原生 TypeScript 构建，没有引入大型前端框架。

## 功能

- 创建或加入 Room，共享同一个剪切板空间
- WebSocket 实时同步在线设备和剪切板消息
- 支持文字、图片、文件上传
- 图片和文件上传进度展示
- 文字消息发送失败后可重试
- 断线自动重连
- 支持修改本机设备别名
- 支持浅色/深色模式
- 支持复制 Room 密钥和邀请信息
- 一次性二维码加入：8 位短码、120 秒有效、扫码一次后失效
- Room 在无人在线后按 TTL 自动释放
- 服务重启后恢复未过期 Room 的消息记录

## 快速开始

### 环境要求

- Node.js 20+
- npm

### 本地开发

```bash
npm install
npm run dev
```

默认访问：

```text
http://localhost:3001
```

如果端口被占用，可以指定端口：

```bash
PORT=3002 npm run dev
```

### 生产构建

```bash
npm run build
npm start
```

构建产物会输出到 `dist/`，生产服务入口是 `dist/server.js`。

## Docker 部署

项目内置 `Dockerfile` 和 `docker-compose.yml`。

```bash
docker compose up -d --build
```

默认映射端口：

```text
http://localhost:3001
```

持久化目录：

- `./uploads:/app/uploads`
- `./data:/app/data`

## 使用方式

1. 打开站点，点击“创建 Room”。
2. 在另一台设备打开同一个站点。
3. 输入 Room 密钥加入，或在已进入 Room 的设备上点击“二维码加入”扫码进入。
4. 发送文字、上传文件，或直接粘贴图片/文件。

二维码加入是一次性的：

- 点击“二维码加入”会立即生成一个 120 秒有效的二维码。
- 二维码链接格式为 `/r/{8位字母数字短码}`。
- 扫码访问一次后立即失效。
- 关闭二维码弹窗后，该二维码也会立即失效。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3001` | HTTP 服务端口 |
| `ROOM_TTL_MS` | `600000` | Room 无人在线后的释放时间，默认 10 分钟 |
| `MAX_FILE_MB` | `25` | 单个上传文件大小上限 |
| `MAX_ROOM_STORAGE_MB` | `500` | 单个 Room 的文件总量上限 |
| `MAX_MESSAGES` | `500` | 单个 Room 保留的最大消息数 |
| `UPLOAD_DIR` | `uploads` | 上传文件目录 |
| `DATA_DIR` | `data` | Room 数据持久化目录 |
| `DEV_RELOAD_PORT` | `35729` | 开发模式 live reload 端口 |

## 项目结构

```text
.
├── public/              # 前端源码和静态入口
│   ├── app.ts
│   ├── index.html
│   └── style.css
├── src/
│   └── server.ts        # Express + WebSocket 服务
├── scripts/
│   ├── build-client.mjs # 前端打包脚本
│   └── dev.mjs          # 开发模式脚本
├── uploads/             # 上传文件目录
├── data/                # Room 持久化数据
├── Dockerfile
└── docker-compose.yml
```

## 安全说明

Room 密钥就是访问凭证：任何持有密钥的人都可以加入 Room。请只把密钥或邀请二维码分享给可信设备。

当前版本的文件和消息内容由服务端中转与保存，并不是端到端加密。如果要在公网部署，建议：

- 使用 HTTPS
- 放在可信网络或反向代理之后
- 配置合理的 `ROOM_TTL_MS`、`MAX_FILE_MB` 和 `MAX_ROOM_STORAGE_MB`
- 定期清理 `uploads/` 和 `data/`

## 开发脚本

```bash
npm run dev          # 开发模式，监听前后端变更
npm run build        # 构建服务端和前端
npm run build:server # 仅构建服务端
npm run build:client # 仅构建前端
npm start            # 启动生产构建产物
```

## License

MIT License. See [LICENSE](./LICENSE).
