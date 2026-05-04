import express from 'express';
import multer from 'multer';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT ?? 3001);
const ROOM_TTL_MS = Number(process.env.ROOM_TTL_MS ?? 10 * 60 * 1000);
const MAX_FILE_MB = Number(process.env.MAX_FILE_MB ?? 25);
const MAX_FILE_BYTES = MAX_FILE_MB * 1024 * 1024;
const MAX_ROOM_STORAGE_MB = Number(process.env.MAX_ROOM_STORAGE_MB ?? 500);
const MAX_ROOM_STORAGE_BYTES = MAX_ROOM_STORAGE_MB * 1024 * 1024;
const MAX_MESSAGES = Number(process.env.MAX_MESSAGES ?? 500);
const MAX_ALIAS_LENGTH = 24;
const INVITE_TTL_MS = 2 * 60 * 1000;
const INVITE_CODE_LENGTH = 8;
const INVITE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const UPLOAD_DIR = path.resolve(process.cwd(), process.env.UPLOAD_DIR ?? 'uploads');
const DATA_DIR = path.resolve(process.cwd(), process.env.DATA_DIR ?? 'data');
const ROOMS_FILE = path.join(DATA_DIR, 'rooms.json');
const PUBLIC_DIR = path.resolve(process.cwd(), 'dist/public');
const DEVICE_COOKIE = 'clipboardroom_device';

type ClipboardMessageType = 'text' | 'image' | 'file';

type ClipboardMessage = {
  id: string;
  clientId?: string;
  type: ClipboardMessageType;
  senderDeviceId: string;
  senderLabel: string;
  senderAlias: string;
  text?: string;
  fileName?: string;
  mimeType?: string;
  size?: number;
  url?: string;
  createdAt: number;
  editedAt?: number;
  revokedAt?: number;
};

type Member = {
  deviceId: string;
  slot: number;
  label: string;
  alias: string;
  joinedAt: number;
  ws: WebSocket;
};

type PublicMember = Omit<Member, 'ws'>;

type Room = {
  key: string;
  createdAt: number;
  updatedAt: number;
  messages: ClipboardMessage[];
  members: Map<string, Member>;
  cleanupTimer?: ReturnType<typeof setTimeout>;
};

type PersistedRoom = {
  key: string;
  createdAt: number;
  updatedAt: number;
  messages: ClipboardMessage[];
};

type InviteCode = {
  roomKey: string;
  createdByDeviceId: string;
  expiresAt: number;
  cleanupTimer: ReturnType<typeof setTimeout>;
};

type ClientEvent =
  | { type: 'joinRoom'; roomKey: string }
  | { type: 'postText'; text: string; clientId?: string }
  | { type: 'editMessage'; messageId: string; text: string }
  | { type: 'revokeMessage'; messageId: string }
  | { type: 'clearMessages' }
  | { type: 'updateAlias'; alias: string }
  | { type: 'ping' };

type ServerEvent =
  | { type: 'welcome'; roomKey: string; self: PublicMember; members: PublicMember[]; messages: ClipboardMessage[] }
  | { type: 'roomState'; members: PublicMember[]; messages: ClipboardMessage[] }
  | { type: 'messageCreated'; message: ClipboardMessage; clientId?: string }
  | { type: 'messageUpdated'; message: ClipboardMessage }
  | { type: 'messageRevoked'; message: ClipboardMessage }
  | { type: 'messagesCleared'; messages: ClipboardMessage[] }
  | { type: 'inviteInvalidated'; code: string; reason: 'used' | 'expired' | 'revoked' }
  | { type: 'presence'; members: PublicMember[] }
  | { type: 'error'; message: string }
  | { type: 'pong' };

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const rooms = new Map<string, Room>();
const invites = new Map<string, InviteCode>();
let saveTimer: ReturnType<typeof setTimeout> | undefined;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES },
});

function makeRoomKey(): string {
  let key = randomBytes(16).toString('hex');
  while (rooms.has(key)) {
    key = randomBytes(16).toString('hex');
  }
  return key;
}

function makeInviteCode(): string {
  let code = '';
  while (!code || invites.has(code)) {
    code = Array.from(randomBytes(INVITE_CODE_LENGTH), (byte) => INVITE_ALPHABET[byte % INVITE_ALPHABET.length]).join('');
  }
  return code;
}

function isValidRoomKey(key: string): boolean {
  return /^[a-f0-9]{32}$/i.test(key);
}

function isValidInviteCode(code: string): boolean {
  return /^[A-Za-z0-9]{8}$/.test(code);
}

function sanitizeAlias(alias: unknown): string {
  if (typeof alias !== 'string') return '';
  return alias.trim().replace(/\s+/g, ' ');
}

function isAliasTooLong(alias: string): boolean {
  return alias.length > MAX_ALIAS_LENGTH;
}

function sanitizeText(text: unknown, max = 50_000): string {
  if (typeof text !== 'string') return '';
  return text.trim().slice(0, max);
}

function normalizeOriginalFileName(name: string): string {
  // multer/busboy 在部分环境下会把 UTF-8 文件名按 latin1 解析，中文会变成类似“ä¸­æ–‡.txt”。
  // 如果解码后明显得到 CJK/日文/韩文字符，则使用修正后的文件名；否则保留原始值。
  if (!name) return 'file';
  if (/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(name)) return name;

  const decoded = Buffer.from(name, 'latin1').toString('utf8');
  if (decoded.includes('�')) return name;
  if (/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(decoded)) return decoded;
  return name;
}

function sanitizeFileName(name: string): string {
  return (
    name
      .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120) || 'file'
  );
}

function readCookie(raw: string | undefined, name: string): string {
  if (!raw) return '';
  const pairs = raw.split(';');
  for (const part of pairs) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('=') || '');
  }
  return '';
}

function getDeviceIdFromRequest(req: express.Request): string {
  const headerId = String(req.header('x-device-id') ?? '').slice(0, 80);
  if (headerId) return headerId;
  const cookieId = readCookie(req.headers.cookie, DEVICE_COOKIE).slice(0, 80);
  return cookieId;
}

function createRoom(): Room {
  const now = Date.now();
  const room: Room = {
    key: makeRoomKey(),
    createdAt: now,
    updatedAt: now,
    messages: [],
    members: new Map(),
  };
  rooms.set(room.key, room);
  queueSaveRooms();
  return room;
}

function createInvite(roomKey: string, createdByDeviceId: string): { code: string; expiresAt: number } {
  const code = makeInviteCode();
  const expiresAt = Date.now() + INVITE_TTL_MS;
  const cleanupTimer = setTimeout(() => {
    invalidateInvite(code, 'expired');
  }, INVITE_TTL_MS);

  invites.set(code, { roomKey, createdByDeviceId, expiresAt, cleanupTimer });
  return { code, expiresAt };
}

function notifyInviteOwner(code: string, invite: InviteCode, reason: 'used' | 'expired' | 'revoked'): void {
  const room = rooms.get(invite.roomKey);
  const owner = room?.members.get(invite.createdByDeviceId);
  if (owner) send(owner.ws, { type: 'inviteInvalidated', code, reason });
}

function invalidateInvite(code: string, reason: 'used' | 'expired' | 'revoked'): InviteCode | undefined {
  const invite = invites.get(code);
  if (!invite) return undefined;

  clearTimeout(invite.cleanupTimer);
  invites.delete(code);
  notifyInviteOwner(code, invite, reason);
  return invite;
}

function consumeInvite(code: string): string | undefined {
  const invite = invites.get(code);
  if (!invite) return undefined;

  if (Date.now() > invite.expiresAt) {
    invalidateInvite(code, 'expired');
    return undefined;
  }

  invalidateInvite(code, 'used');
  return invite.roomKey;
}

function toPublicMember(member: Member): PublicMember {
  const { ws: _ws, ...publicMember } = member;
  return publicMember;
}

function getPublicMembers(room: Room): PublicMember[] {
  return [...room.members.values()].map(toPublicMember).sort((a, b) => a.slot - b.slot);
}

function send(ws: WebSocket, event: ServerEvent): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(event));
  }
}

function broadcast(room: Room, event: ServerEvent): void {
  for (const member of room.members.values()) {
    send(member.ws, event);
  }
}

function assignSlot(room: Room): number {
  const used = new Set([...room.members.values()].map((member) => member.slot));
  let slot = 1;
  while (used.has(slot)) slot += 1;
  return slot;
}

function cancelCleanup(room: Room): void {
  if (room.cleanupTimer) {
    clearTimeout(room.cleanupTimer);
    room.cleanupTimer = undefined;
  }
}

function scheduleCleanup(room: Room): void {
  cancelCleanup(room);
  room.cleanupTimer = setTimeout(async () => {
    const latest = rooms.get(room.key);
    if (!latest || latest.members.size > 0) return;

    rooms.delete(room.key);
    await fs.rm(path.join(UPLOAD_DIR, room.key), { recursive: true, force: true }).catch(() => undefined);
    queueSaveRooms();
    console.log(`[room] released ${room.key}`);
  }, ROOM_TTL_MS);
}

function touchRoom(room: Room): void {
  room.updatedAt = Date.now();
  queueSaveRooms();
}

function trimMessages(room: Room): void {
  if (room.messages.length <= MAX_MESSAGES) return;
  const removed = room.messages.splice(0, room.messages.length - MAX_MESSAGES);
  for (const message of removed) {
    void removeFileIfAny(room, message);
  }
  touchRoom(room);
}

function getRoomStorageBytes(room: Room): number {
  return room.messages.reduce((total, message) => {
    if (message.revokedAt || message.type === 'text') return total;
    return total + (message.size ?? 0);
  }, 0);
}

function getStoredFilePath(roomKey: string, message: ClipboardMessage): string | undefined {
  if (message.type === 'text' || !message.fileName) return undefined;
  const safeName = sanitizeFileName(message.fileName);
  const storedName = `${message.id}-${safeName}`;
  const roomDir = path.resolve(UPLOAD_DIR, roomKey);
  const absolute = path.resolve(roomDir, storedName);
  if (!absolute.startsWith(`${roomDir}${path.sep}`) && absolute !== roomDir) return undefined;
  return absolute;
}

async function removeFileIfAny(room: Room, message: ClipboardMessage): Promise<void> {
  const filePath = getStoredFilePath(room.key, message);
  if (!filePath) return;
  await fs.rm(filePath, { force: true }).catch(() => undefined);
}

async function removeFilesForMessages(room: Room, messages: ClipboardMessage[]): Promise<void> {
  await Promise.all(messages.map((message) => removeFileIfAny(room, message)));
}

function findEditableOwnMessage(room: Room, deviceId: string, messageId: string): ClipboardMessage | undefined {
  const message = room.messages.find((item) => item.id === messageId);
  if (!message || message.senderDeviceId !== deviceId || message.revokedAt) return undefined;
  return message;
}

function serializeRooms(): PersistedRoom[] {
  return [...rooms.values()].map((room) => ({
    key: room.key,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
    messages: room.messages,
  }));
}

function queueSaveRooms(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    void saveRoomsNow();
  }, 200);
}

async function saveRoomsNow(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tempFile = `${ROOMS_FILE}.tmp`;
  await fs.writeFile(tempFile, JSON.stringify(serializeRooms(), null, 2), 'utf8');
  await fs.rename(tempFile, ROOMS_FILE);
}

async function loadRooms(): Promise<void> {
  try {
    const raw = await fs.readFile(ROOMS_FILE, 'utf8');
    const parsed = JSON.parse(raw) as PersistedRoom[];
    if (!Array.isArray(parsed)) return;

    for (const item of parsed) {
      if (!item || !isValidRoomKey(item.key)) continue;
      const messages = Array.isArray(item.messages) ? item.messages : [];
      for (const message of messages) {
        if (message && (message.type === 'image' || message.type === 'file')) {
          message.url = `/api/files/${message.id}`;
        }
      }
      rooms.set(item.key, {
        key: item.key.toLowerCase(),
        createdAt: Number(item.createdAt) || Date.now(),
        updatedAt: Number(item.updatedAt) || Date.now(),
        messages,
        members: new Map(),
      });
    }

    // 服务重启后，恢复出来的 Room 默认无人在线，因此重新启动释放计时。
    for (const room of rooms.values()) {
      scheduleCleanup(room);
    }

    console.log(`[room] restored ${rooms.size} room(s)`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('[room] failed to restore rooms:', error);
    }
  }
}

app.use(express.json({ limit: '256kb' }));

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    app: 'ClipboardRoom',
    rooms: rooms.size,
    maxFileMB: MAX_FILE_MB,
    maxRoomStorageMB: MAX_ROOM_STORAGE_MB,
    maxAliasLength: MAX_ALIAS_LENGTH,
    inviteTtlMs: INVITE_TTL_MS,
    roomTtlMs: ROOM_TTL_MS,
  });
});

app.post('/api/rooms', (_req, res) => {
  const room = createRoom();
  res.json({ key: room.key, ttlMs: ROOM_TTL_MS });
});

app.post('/api/rooms/join', (req, res) => {
  const key = String(req.body?.key ?? '').toLowerCase();
  const room = rooms.get(key);

  if (!isValidRoomKey(key) || !room) {
    res.status(404).json({ error: 'Room 不存在或已释放' });
    return;
  }

  res.json({ key: room.key, createdAt: room.createdAt, updatedAt: room.updatedAt, online: room.members.size });
});

app.post('/api/invites', (req, res) => {
  const key = String(req.body?.roomKey ?? '').toLowerCase();
  const deviceId = String(req.header('x-device-id') ?? '');
  const room = rooms.get(key);

  if (!isValidRoomKey(key) || !room) {
    res.status(404).json({ error: 'Room 不存在或已释放' });
    return;
  }

  if (!room.members.has(deviceId)) {
    res.status(401).json({ error: '请先进入 Room，再获取二维码' });
    return;
  }

  const invite = createInvite(room.key, deviceId);
  res.json({
    code: invite.code,
    path: `/r/${invite.code}`,
    expiresAt: invite.expiresAt,
    ttlMs: INVITE_TTL_MS,
  });
});

app.post('/api/invites/:code/redeem', (req, res) => {
  const code = String(req.params.code ?? '');
  if (!isValidInviteCode(code)) {
    res.status(404).json({ error: '邀请二维码无效' });
    return;
  }

  const roomKey = consumeInvite(code);
  const room = roomKey ? rooms.get(roomKey) : undefined;
  if (!roomKey || !room) {
    res.status(410).json({ error: '邀请二维码已失效，请重新获取' });
    return;
  }

  res.json({ key: room.key });
});

app.delete('/api/invites/:code', (req, res) => {
  const code = String(req.params.code ?? '');
  const deviceId = String(req.header('x-device-id') ?? '');
  const invite = invites.get(code);

  if (!isValidInviteCode(code) || !invite) {
    res.status(204).end();
    return;
  }

  if (invite.createdByDeviceId !== deviceId) {
    res.status(403).json({ error: '只能关闭自己创建的二维码' });
    return;
  }

  invalidateInvite(code, 'revoked');
  res.status(204).end();
});

app.post('/api/uploads', upload.single('file'), async (req, res) => {
  const key = String(req.body?.roomKey ?? '').toLowerCase();
  const deviceId = String(req.header('x-device-id') ?? '');
  const room = rooms.get(key);

  if (!isValidRoomKey(key) || !room) {
    res.status(404).json({ error: 'Room 不存在或已释放' });
    return;
  }

  const member = room.members.get(deviceId);
  if (!member) {
    res.status(401).json({ error: '请先进入 Room，再上传文件' });
    return;
  }

  if (!req.file) {
    res.status(400).json({ error: '没有收到文件' });
    return;
  }

  if (getRoomStorageBytes(room) + req.file.size > MAX_ROOM_STORAGE_BYTES) {
    res.status(413).json({ error: `当前 Room 文件总量不能超过 ${MAX_ROOM_STORAGE_MB}MB` });
    return;
  }

  const messageId = randomUUID();
  const originalName = normalizeOriginalFileName(req.file.originalname);
  const safeName = sanitizeFileName(originalName);
  const storedName = `${messageId}-${safeName}`;
  const roomDir = path.join(UPLOAD_DIR, key);
  await fs.mkdir(roomDir, { recursive: true });
  await fs.writeFile(path.join(roomDir, storedName), req.file.buffer);

  const message: ClipboardMessage = {
    id: messageId,
    type: req.file.mimetype.startsWith('image/') ? 'image' : 'file',
    senderDeviceId: member.deviceId,
    senderLabel: member.label,
    senderAlias: member.alias,
    fileName: safeName,
    mimeType: req.file.mimetype,
    size: req.file.size,
    url: `/api/files/${messageId}`,
    createdAt: Date.now(),
  };

  room.messages.push(message);
  touchRoom(room);
  trimMessages(room);
  broadcast(room, { type: 'messageCreated', message });
  res.json({ message });
});

function findFileMessage(messageId: string): { room: Room; message: ClipboardMessage } | undefined {
  for (const room of rooms.values()) {
    const message = room.messages.find((item) => item.id === messageId);
    if (!message || message.revokedAt) continue;
    if (message.type !== 'image' && message.type !== 'file') continue;
    return { room, message };
  }
  return undefined;
}

function setFileHeaders(res: express.Response, message: ClipboardMessage, download: boolean): void {
  const fileName = message.fileName || 'file';
  const safeName = fileName.replace(/[\r\n]/g, '').replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '');
  const fallbackName = safeName.trim() || 'file';
  const encodedName = encodeURIComponent(fileName.replace(/[\r\n]/g, ''));
  res.setHeader('Content-Type', message.mimeType || 'application/octet-stream');
  res.setHeader(
    'Content-Disposition',
    `${download ? 'attachment' : 'inline'}; filename="${fallbackName}"; filename*=UTF-8''${encodedName}`,
  );
}

function getFileAccess(req: express.Request, res: express.Response): { room: Room; message: ClipboardMessage; filePath: string } | undefined {
  const messageId = String(req.params.messageId ?? '');
  const matched = findFileMessage(messageId);
  if (!matched) {
    res.status(404).json({ error: '文件不存在或已撤回' });
    return undefined;
  }

  const deviceId = getDeviceIdFromRequest(req);
  if (!deviceId) {
    res.status(401).json({ error: '缺少设备信息' });
    return undefined;
  }

  if (!matched.room.members.has(deviceId)) {
    res.status(401).json({ error: '请先进入 Room，再访问文件' });
    return undefined;
  }

  const filePath = getStoredFilePath(matched.room.key, matched.message);
  if (!filePath) {
    res.status(404).json({ error: '文件不存在或已撤回' });
    return undefined;
  }

  return { room: matched.room, message: matched.message, filePath };
}

app.get('/api/files/:messageId/meta', (req, res) => {
  const access = getFileAccess(req, res);
  if (!access) return;
  const { message } = access;
  res.json({
    id: message.id,
    fileName: message.fileName,
    mimeType: message.mimeType,
    size: message.size,
    type: message.type,
  });
});

app.get('/api/files/:messageId', (req, res) => {
  const access = getFileAccess(req, res);
  if (!access) return;
  setFileHeaders(res, access.message, false);
  res.sendFile(access.filePath);
});

app.get('/api/files/:messageId/download', (req, res) => {
  const access = getFileAccess(req, res);
  if (!access) return;
  setFileHeaders(res, access.message, true);
  res.sendFile(access.filePath);
});

app.use('/api', (_req, res) => {
  res.status(404).json({ error: '接口不存在' });
});

app.use(express.static(PUBLIC_DIR));
app.get('*', (_req, res) => {
  const indexFile = path.join(PUBLIC_DIR, 'index.html');
  if (!existsSync(indexFile)) {
    res.status(500).send('前端文件不存在，请先执行 npm run build');
    return;
  }
  res.sendFile(indexFile);
});

wss.on('connection', (ws, req) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const deviceId = String(url.searchParams.get('deviceId') ?? '').slice(0, 80);
  const aliasFromClient = sanitizeAlias(url.searchParams.get('alias'));
  let joinedRoom: Room | undefined;

  if (!deviceId) {
    send(ws, { type: 'error', message: '设备 ID 无效' });
    ws.close(1008, 'invalid device');
    return;
  }

  if (isAliasTooLong(aliasFromClient)) {
    send(ws, { type: 'error', message: `别名不能超过 ${MAX_ALIAS_LENGTH} 个字符` });
    ws.close(1008, 'alias too long');
    return;
  }

  const removeCurrentMember = (): void => {
    if (!joinedRoom) return;

    const current = joinedRoom.members.get(deviceId);
    if (!current || current.ws !== ws) return;

    joinedRoom.members.delete(deviceId);
    broadcast(joinedRoom, { type: 'presence', members: getPublicMembers(joinedRoom) });

    if (joinedRoom.members.size === 0) {
      scheduleCleanup(joinedRoom);
    }
  };

  const joinRoom = (key: string): void => {
    const room = rooms.get(key);
    if (!isValidRoomKey(key) || !room) {
      send(ws, { type: 'error', message: 'Room 不存在或已释放' });
      ws.close(1008, 'invalid room');
      return;
    }

    cancelCleanup(room);

    const oldMember = room.members.get(deviceId);
    let slot = oldMember?.slot;
    if (oldMember) {
      room.members.delete(deviceId);
      oldMember.ws.close(4000, 'same device reconnected');
    }
    if (!slot || [...room.members.values()].some((member) => member.slot === slot)) {
      slot = assignSlot(room);
    }

    const member: Member = {
      deviceId,
      slot,
      label: `P${slot}`,
      alias: aliasFromClient || `P${slot}`,
      joinedAt: Date.now(),
      ws,
    };

    joinedRoom = room;
    room.members.set(deviceId, member);

    send(ws, {
      type: 'welcome',
      roomKey: room.key,
      self: toPublicMember(member),
      members: getPublicMembers(room),
      messages: room.messages,
    });
    broadcast(room, { type: 'presence', members: getPublicMembers(room) });
  };

  ws.on('message', async (raw) => {
    let event: ClientEvent;
    try {
      event = JSON.parse(String(raw)) as ClientEvent;
    } catch {
      send(ws, { type: 'error', message: '消息格式错误' });
      return;
    }

    if (event.type === 'joinRoom') {
      if (joinedRoom) return;
      joinRoom(String(event.roomKey ?? '').toLowerCase());
      return;
    }

    const room = joinedRoom;
    if (!room) {
      send(ws, { type: 'error', message: '请先加入 Room' });
      return;
    }

    const current = room.members.get(deviceId);
    if (!current || current.ws !== ws) return;

    if (event.type === 'ping') {
      send(ws, { type: 'pong' });
      return;
    }

    if (event.type === 'updateAlias') {
      const alias = sanitizeAlias(event.alias);
      if (isAliasTooLong(alias)) {
        send(ws, { type: 'error', message: `别名不能超过 ${MAX_ALIAS_LENGTH} 个字符` });
        return;
      }
      current.alias = alias || current.label;
      broadcast(room, { type: 'presence', members: getPublicMembers(room) });
      return;
    }

    if (event.type === 'postText') {
      const text = sanitizeText(event.text);
      if (!text) {
        send(ws, { type: 'error', message: '不能发送空内容' });
        return;
      }

      const clientId = typeof event.clientId === 'string' ? event.clientId.slice(0, 80) : undefined;
      const existingMessage = clientId
        ? room.messages.find((item) => item.senderDeviceId === current.deviceId && item.clientId === clientId)
        : undefined;
      if (existingMessage) {
        send(ws, { type: 'messageCreated', message: existingMessage, clientId });
        return;
      }

      const message: ClipboardMessage = {
        id: randomUUID(),
        clientId,
        type: 'text',
        senderDeviceId: current.deviceId,
        senderLabel: current.label,
        senderAlias: current.alias,
        text,
        createdAt: Date.now(),
      };
      room.messages.push(message);
      touchRoom(room);
      trimMessages(room);
      for (const member of room.members.values()) {
        send(member.ws, {
          type: 'messageCreated',
          message,
          ...(member.deviceId === current.deviceId && clientId ? { clientId } : {}),
        });
      }
      return;
    }

    if (event.type === 'editMessage') {
      const message = findEditableOwnMessage(room, deviceId, event.messageId);
      if (!message) {
        send(ws, { type: 'error', message: '只能修改自己未撤回的内容' });
        return;
      }
      if (message.type !== 'text') {
        send(ws, { type: 'error', message: '当前版本只允许修改文字内容，文件和图片请撤回后重新发送' });
        return;
      }
      const text = sanitizeText(event.text);
      if (!text) {
        send(ws, { type: 'error', message: '内容不能为空' });
        return;
      }
      message.text = text;
      message.editedAt = Date.now();
      touchRoom(room);
      broadcast(room, { type: 'messageUpdated', message });
      return;
    }

    if (event.type === 'revokeMessage') {
      const message = findEditableOwnMessage(room, deviceId, event.messageId);
      if (!message) {
        send(ws, { type: 'error', message: '只能撤回自己未撤回的内容' });
        return;
      }
      await removeFileIfAny(room, message);
      message.revokedAt = Date.now();
      message.text = undefined;
      message.url = undefined;
      touchRoom(room);
      broadcast(room, { type: 'messageRevoked', message });
      return;
    }

    if (event.type === 'clearMessages') {
      await removeFilesForMessages(room, room.messages);
      room.messages = [];
      touchRoom(room);
      broadcast(room, { type: 'messagesCleared', messages: [] });
    }
  });

  ws.on('close', removeCurrentMember);
});

server.listen(PORT, async () => {
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  await fs.mkdir(DATA_DIR, { recursive: true });
  await loadRooms();
  console.log(`ClipboardRoom running at http://localhost:${PORT}`);
});
