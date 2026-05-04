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
};

type ServerEvent =
  | { type: 'welcome'; roomKey: string; self: Member; members: Member[]; messages: ClipboardMessage[] }
  | { type: 'roomState'; members: Member[]; messages: ClipboardMessage[] }
  | { type: 'messageCreated'; message: ClipboardMessage; clientId?: string }
  | { type: 'messageUpdated'; message: ClipboardMessage }
  | { type: 'messageRevoked'; message: ClipboardMessage }
  | { type: 'messagesCleared'; messages: ClipboardMessage[] }
  | { type: 'inviteInvalidated'; code: string; reason: 'used' | 'expired' | 'revoked' }
  | { type: 'presence'; members: Member[] }
  | { type: 'error'; message: string }
  | { type: 'pong' };

type View = 'home' | 'room';
type ConnectionStatus = 'idle' | 'connecting' | 'reconnecting' | 'online' | 'offline';

type PendingText = {
  clientId: string;
  text: string;
  createdAt: number;
  status: 'sending' | 'failed';
  error?: string;
};

type UploadItem = {
  id: string;
  file: File;
  fileName: string;
  size: number;
  progress: number;
  status: 'uploading' | 'failed' | 'done';
  error?: string;
};

type InviteCode = {
  code: string;
  link: string;
  expiresAt: number;
};

type AppState = {
  view: View;
  roomKey: string;
  deviceId: string;
  alias: string;
  self?: Member;
  members: Member[];
  messages: ClipboardMessage[];
  pendingTexts: PendingText[];
  uploads: UploadItem[];
  ws?: WebSocket;
  status: ConnectionStatus;
  toast: string;
  theme: 'light' | 'dark';
  joinKey: string;
  textDraft: string;
  editingId: string | null;
  editingText: string;
  imagePreviewId: string | null;
  imagePreviewZoomed: boolean;
  showInviteQr: boolean;
  invite?: InviteCode;
  inviteLoading: boolean;
  inviteError: string;
};

const APP_NAME = 'ClipboardRoom';
const MAX_ALIAS_LENGTH = 24;
const SEND_TIMEOUT_MS = 8_000;
const RECONNECT_MAX_DELAY_MS = 10_000;
const INVITE_CODE_PATTERN = /^[A-Za-z0-9]{8}$/;
const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('missing #app');

const STORAGE = {
  deviceId: 'clipboardroom.deviceId',
  alias: 'clipboardroom.alias',
  theme: 'clipboardroom.theme',
  roomKey: 'clipboardroom.roomKey',
};

const DEVICE_COOKIE = 'clipboardroom_device';

const LEGACY_STORAGE = {
  deviceId: 'cloud-clipboard.deviceId',
  alias: 'cloud-clipboard.alias',
  theme: 'cloud-clipboard.theme',
  roomKey: 'cloud-clipboard.roomKey',
};

const state: AppState = {
  view: 'home',
  roomKey: '',
  deviceId: getOrCreateDeviceId(),
  alias: getInitialAlias(),
  members: [],
  messages: [],
  pendingTexts: [],
  uploads: [],
  status: 'idle',
  toast: '',
  theme: (getStored(STORAGE.theme, LEGACY_STORAGE.theme) as 'light' | 'dark' | null) || 'light',
  joinKey: '',
  textDraft: '',
  editingId: null,
  editingText: '',
  imagePreviewId: null,
  imagePreviewZoomed: false,
  showInviteQr: false,
  invite: undefined,
  inviteLoading: false,
  inviteError: '',
};

let pingTimer: number | undefined;
let reconnectTimer: number | undefined;
let inviteExpiryTimer: number | undefined;
let inviteTickTimer: number | undefined;
let reconnectAttempts = 0;
let finiteFieldTables: { exp: number[]; log: number[] } | undefined;
const pendingSendTimers = new Map<string, number>();

function getStored(key: string, legacyKey?: string): string | null {
  const value = localStorage.getItem(key);
  if (value) return value;
  return legacyKey ? localStorage.getItem(legacyKey) : null;
}

function getOrCreateDeviceId(): string {
  const existed = getStored(STORAGE.deviceId, LEGACY_STORAGE.deviceId);
  if (existed) {
    localStorage.setItem(STORAGE.deviceId, existed);
    return existed;
  }

  const generated = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
  localStorage.setItem(STORAGE.deviceId, generated);
  return generated;
}

function syncDeviceCookie(): void {
  const secure = location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${DEVICE_COOKIE}=${encodeURIComponent(state.deviceId)}; Path=/; SameSite=Lax${secure}`;
}

function getDeviceInfo(): string {
  const ua = navigator.userAgent;
  const platform = navigator.platform || 'Unknown';
  const os = /Mac/i.test(platform)
    ? 'macOS'
    : /Win/i.test(platform)
      ? 'Windows'
      : /iPhone|iPad|iPod/i.test(ua)
        ? 'iOS'
        : /Android/i.test(ua)
          ? 'Android'
          : /Linux/i.test(platform)
            ? 'Linux'
            : platform;

  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Chrome\//.test(ua)
      ? 'Chrome'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Safari\//.test(ua)
          ? 'Safari'
          : 'Browser';

  return `${os} · ${browser}`;
}

function getInitialAlias(): string {
  const savedAlias = normalizeAliasInput(getStored(STORAGE.alias, LEGACY_STORAGE.alias) || '');
  if (savedAlias && savedAlias.length <= MAX_ALIAS_LENGTH) return savedAlias;

  const deviceInfo = getDeviceInfo();
  localStorage.setItem(STORAGE.alias, deviceInfo);
  return deviceInfo;
}

function escapeHtml(input = ''): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function escapeAttr(input = ''): string {
  return escapeHtml(input).replace(/`/g, '&#096;');
}

function formatSize(size?: number): string {
  if (!size) return '';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function formatTime(ts: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(ts);
}

function makeClientId(): string {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function toast(message: string): void {
  state.toast = message;
  render();
  window.setTimeout(() => {
    if (state.toast === message) {
      state.toast = '';
      render();
    }
  }, 2400);
}

function normalizeRoomKey(key: string): string {
  return key.trim().toLowerCase().replace(/\s+/g, '');
}

function normalizeAliasInput(alias: string): string {
  return alias.trim().replace(/\s+/g, ' ');
}

function isValidRoomKey(key: string): boolean {
  return /^[a-f0-9]{32}$/i.test(key);
}

function getInviteCodeFromUrl(): string {
  const pathMatch = location.pathname.match(/^\/r\/([A-Za-z0-9]{8})$/);
  return pathMatch ? pathMatch[1] : '';
}

function getMainLink(): string {
  return `${location.origin}/`;
}

function clearLegacyKeyUrlIfNeeded(): boolean {
  const params = new URLSearchParams(location.search);
  const shouldClear = location.pathname.startsWith('/r/') || params.has('roomKey') || params.has('key');
  if (!shouldClear) return false;

  history.replaceState({ view: 'home' }, '', '/');
  return true;
}

function getFileUrl(messageId: string): string {
  return `/api/files/${encodeURIComponent(messageId)}`;
}

function getFileDownloadUrl(messageId: string): string {
  return `/api/files/${encodeURIComponent(messageId)}/download`;
}

async function readResponseError(res: Response, fallback: string): Promise<string> {
  try {
    const data = await res.json();
    return data.error || fallback;
  } catch {
    return fallback;
  }
}

async function createRoom(): Promise<void> {
  try {
    const res = await fetch('/api/rooms', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '创建 Room 失败');
    enterRoom(data.key);
  } catch (error) {
    toast(error instanceof Error ? error.message : '创建 Room 失败');
  }
}

async function joinRoom(): Promise<void> {
  const key = normalizeRoomKey(state.joinKey);
  if (!isValidRoomKey(key)) {
    toast('请输入 32 位 Room 密钥');
    return;
  }

  try {
    const res = await fetch('/api/rooms/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key }),
    });
    if (!res.ok) throw new Error(await readResponseError(res, 'Room 不存在'));
    enterRoom(key);
  } catch (error) {
    toast(error instanceof Error ? error.message : '加入失败');
  }
}

async function redeemInviteCode(code: string): Promise<void> {
  const safeCode = code.trim();
  history.replaceState({ view: 'home' }, '', '/');
  render();

  if (!INVITE_CODE_PATTERN.test(safeCode)) {
    toast('邀请二维码无效');
    return;
  }

  try {
    const res = await fetch(`/api/invites/${safeCode}/redeem`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok || !isValidRoomKey(data.key || '')) {
      throw new Error(data.error || '邀请二维码已失效');
    }
    localStorage.setItem(STORAGE.roomKey, data.key);
    enterRoom(data.key, { replaceUrl: true });
  } catch (error) {
    toast(error instanceof Error ? error.message : '邀请二维码已失效');
  }
}

function enterRoom(roomKey: string, options: { updateUrl?: boolean; replaceUrl?: boolean } = {}): void {
  const updateUrl = options.updateUrl ?? true;

  state.view = 'room';
  state.roomKey = roomKey;
  state.joinKey = '';
  state.status = 'connecting';
  state.members = [];
  state.messages = [];
  state.pendingTexts = [];
  state.uploads = [];
  state.self = undefined;
  state.imagePreviewId = null;
  state.imagePreviewZoomed = false;
  state.showInviteQr = false;
  resetInviteState();
  localStorage.setItem(STORAGE.roomKey, roomKey);

  if (updateUrl && (location.pathname !== '/room' || location.search)) {
    const method = options.replaceUrl ? 'replaceState' : 'pushState';
    history[method]({ view: 'room' }, '', '/room');
  }

  render();
  connectWs();
}

function leaveRoom(options: { updateUrl?: boolean; clearSaved?: boolean } = {}): void {
  const updateUrl = options.updateUrl ?? true;
  const clearSaved = options.clearSaved ?? true;

  if (state.ws) {
    const ws = state.ws;
    state.ws = undefined;
    ws.close();
  }
  clearPingTimer();
  clearReconnectTimer();
  pendingSendTimers.forEach((timer) => window.clearTimeout(timer));
  pendingSendTimers.clear();
  if (clearSaved) localStorage.removeItem(STORAGE.roomKey);

  state.view = 'home';
  state.roomKey = '';
  state.members = [];
  state.messages = [];
  state.pendingTexts = [];
  state.uploads = [];
  state.self = undefined;
  state.imagePreviewId = null;
  state.imagePreviewZoomed = false;
  state.showInviteQr = false;
  resetInviteState();
  state.status = 'idle';

  if (updateUrl && location.pathname !== '/') {
    history.pushState({ view: 'home' }, '', '/');
  }

  render();
}

function clearPingTimer(): void {
  if (pingTimer) {
    window.clearInterval(pingTimer);
    pingTimer = undefined;
  }
}

function clearReconnectTimer(): void {
  if (reconnectTimer) {
    window.clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }
}

function clearInviteExpiryTimer(): void {
  if (inviteExpiryTimer) {
    window.clearTimeout(inviteExpiryTimer);
    inviteExpiryTimer = undefined;
  }
}

function clearInviteTickTimer(): void {
  if (inviteTickTimer) {
    window.clearInterval(inviteTickTimer);
    inviteTickTimer = undefined;
  }
}

function resetInviteState(): void {
  clearInviteExpiryTimer();
  clearInviteTickTimer();
  state.invite = undefined;
  state.inviteLoading = false;
  state.inviteError = '';
}

function scheduleInviteExpiry(expiresAt: number): void {
  clearInviteExpiryTimer();
  const delay = Math.max(0, expiresAt - Date.now());
  inviteExpiryTimer = window.setTimeout(() => {
    if (!state.invite || state.invite.expiresAt !== expiresAt) return;
    state.invite = undefined;
    state.inviteError = '二维码已失效，请重新获取';
    clearInviteTickTimer();
    render();
  }, delay);

  clearInviteTickTimer();
  inviteTickTimer = window.setInterval(() => {
    if (!state.showInviteQr || !state.invite) return;
    render();
  }, 1000);
}

function markSendingTextsFailed(error: string): void {
  let changed = false;
  for (const pending of state.pendingTexts) {
    if (pending.status === 'sending') {
      pending.status = 'failed';
      pending.error = error;
      changed = true;
    }
  }
  pendingSendTimers.forEach((timer) => window.clearTimeout(timer));
  pendingSendTimers.clear();
  if (changed) render();
}

function scheduleReconnect(): void {
  if (state.view !== 'room' || !state.roomKey || reconnectTimer) return;

  reconnectAttempts += 1;
  const delay = Math.min(RECONNECT_MAX_DELAY_MS, 800 * 2 ** Math.min(reconnectAttempts - 1, 4));
  state.status = 'reconnecting';
  render();

  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = undefined;
    if (state.view === 'room' && state.roomKey) connectWs({ reconnecting: true });
  }, delay);
}

function connectWs(options: { reconnecting?: boolean } = {}): void {
  clearReconnectTimer();
  if (state.ws) state.ws.close();
  clearPingTimer();
  state.status = options.reconnecting ? 'reconnecting' : 'connecting';

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const params = new URLSearchParams({
    deviceId: state.deviceId,
    alias: state.alias,
  });
  const ws = new WebSocket(`${protocol}//${location.host}/ws?${params.toString()}`);
  state.ws = ws;

  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ type: 'joinRoom', roomKey: state.roomKey }));
  });

  ws.addEventListener('message', (event) => {
    const data = JSON.parse(String(event.data)) as ServerEvent;
    handleServerEvent(data);
  });

  ws.addEventListener('close', (event) => {
    if (state.ws !== ws) return;
    state.ws = undefined;
    clearPingTimer();
    markSendingTextsFailed('连接已断开');
    if (event.code === 1008) {
      state.status = 'offline';
      render();
      return;
    }
    render();
    scheduleReconnect();
  });

  ws.addEventListener('error', () => {
    if (state.status !== 'reconnecting') toast('WebSocket 连接异常，正在重连');
  });
}

function handleServerEvent(event: ServerEvent): void {
  if (event.type === 'welcome') {
    state.status = 'online';
    reconnectAttempts = 0;
    clearPingTimer();
    pingTimer = window.setInterval(() => sendWs({ type: 'ping' }), 25_000);
    state.self = event.self;
    state.members = event.members;
    state.messages = event.messages;
    reconcilePendingTextsWithMessages();
    localStorage.setItem(STORAGE.roomKey, event.roomKey);
    render();
    scrollToBottom();
    return;
  }

  if (event.type === 'presence') {
    state.members = event.members;
    state.self = event.members.find((member) => member.deviceId === state.deviceId) || state.self;
    render();
    return;
  }

  if (event.type === 'messageCreated') {
    if (event.clientId) {
      const timer = pendingSendTimers.get(event.clientId);
      if (timer) window.clearTimeout(timer);
      pendingSendTimers.delete(event.clientId);
      state.pendingTexts = state.pendingTexts.filter((item) => item.clientId !== event.clientId);
    }
    upsertMessage(event.message);
    render();
    scrollToBottom();
    return;
  }

  if (event.type === 'messageUpdated' || event.type === 'messageRevoked') {
    upsertMessage(event.message);
    ensurePreviewMessage();
    render();
    return;
  }

  if (event.type === 'messagesCleared') {
    state.messages = event.messages;
    state.editingId = null;
    state.editingText = '';
    state.imagePreviewId = null;
    state.imagePreviewZoomed = false;
    render();
    return;
  }

  if (event.type === 'inviteInvalidated') {
    if (state.invite?.code === event.code) {
      state.invite = undefined;
      state.inviteError =
        event.reason === 'used'
          ? '二维码已被使用，请重新获取'
          : event.reason === 'expired'
            ? '二维码已失效，请重新获取'
            : '二维码已关闭，请重新获取';
      clearInviteExpiryTimer();
      clearInviteTickTimer();
      render();
    }
    return;
  }

  if (event.type === 'roomState') {
    state.members = event.members;
    state.messages = event.messages;
    reconcilePendingTextsWithMessages();
    ensurePreviewMessage();
    render();
    return;
  }

  if (event.type === 'error') {
    toast(event.message);
    if (/Room 不存在|已释放/.test(event.message)) {
      localStorage.removeItem(STORAGE.roomKey);
    }
  }
}

function upsertMessage(message: ClipboardMessage): void {
  const index = state.messages.findIndex((item) => item.id === message.id);
  if (index < 0) state.messages.push(message);
  else state.messages[index] = message;
}

function reconcilePendingTextsWithMessages(): void {
  const deliveredClientIds = new Set(state.messages.map((message) => message.clientId).filter(Boolean));
  state.pendingTexts = state.pendingTexts.filter((pending) => {
    if (!deliveredClientIds.has(pending.clientId)) return true;
    const timer = pendingSendTimers.get(pending.clientId);
    if (timer) window.clearTimeout(timer);
    pendingSendTimers.delete(pending.clientId);
    return false;
  });
}

function sendWs(data: unknown): boolean {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return false;
  state.ws.send(JSON.stringify(data));
  return true;
}

function sendText(): void {
  const text = state.textDraft.trim();
  if (!text) return;
  queueTextMessage(text);
  state.textDraft = '';
  render();
}

function queueTextMessage(text: string, existingClientId?: string): void {
  const clientId = existingClientId || makeClientId();
  const pending: PendingText =
    state.pendingTexts.find((item) => item.clientId === clientId) || {
      clientId,
      text,
      createdAt: Date.now(),
      status: 'sending',
    };

  pending.text = text;
  pending.status = 'sending';
  pending.error = undefined;
  if (!state.pendingTexts.some((item) => item.clientId === clientId)) {
    state.pendingTexts.push(pending);
  }

  const sent = sendWs({ type: 'postText', text, clientId });
  if (!sent) {
    pending.status = 'failed';
    pending.error = '连接未就绪';
    render();
    return;
  }

  const previousTimer = pendingSendTimers.get(clientId);
  if (previousTimer) window.clearTimeout(previousTimer);
  pendingSendTimers.set(
    clientId,
    window.setTimeout(() => {
      const latest = state.pendingTexts.find((item) => item.clientId === clientId);
      if (!latest || latest.status !== 'sending') return;
      latest.status = 'failed';
      latest.error = '发送确认超时';
      pendingSendTimers.delete(clientId);
      render();
    }, SEND_TIMEOUT_MS),
  );
}

function retryPendingText(clientId: string): void {
  const pending = state.pendingTexts.find((item) => item.clientId === clientId);
  if (!pending) return;
  queueTextMessage(pending.text, clientId);
  render();
}

function discardPendingText(clientId: string): void {
  const timer = pendingSendTimers.get(clientId);
  if (timer) window.clearTimeout(timer);
  pendingSendTimers.delete(clientId);
  state.pendingTexts = state.pendingTexts.filter((item) => item.clientId !== clientId);
  render();
}

async function uploadFiles(files: FileList | File[]): Promise<void> {
  const list = Array.from(files);
  for (const file of list) {
    const upload: UploadItem = {
      id: makeClientId(),
      file,
      fileName: file.name || 'file',
      size: file.size,
      progress: 0,
      status: 'uploading',
    };
    state.uploads.push(upload);
    uploadSingleFile(upload);
  }
  render();
}

function uploadSingleFile(upload: UploadItem): void {
  if (!state.roomKey || state.status !== 'online') {
    upload.status = 'failed';
    upload.error = '连接未就绪';
    upload.progress = 0;
    render();
    return;
  }

  const form = new FormData();
  form.append('roomKey', state.roomKey);
  form.append('file', upload.file, upload.file.name);
  upload.status = 'uploading';
  upload.error = undefined;
  upload.progress = 0;

  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/uploads');
  xhr.setRequestHeader('x-device-id', state.deviceId);

  xhr.upload.addEventListener('progress', (event) => {
    if (!event.lengthComputable) return;
    upload.progress = Math.max(1, Math.round((event.loaded / event.total) * 100));
    render();
  });

  xhr.addEventListener('load', () => {
    if (xhr.status >= 200 && xhr.status < 300) {
      upload.progress = 100;
      upload.status = 'done';
      render();
      window.setTimeout(() => {
        state.uploads = state.uploads.filter((item) => item.id !== upload.id);
        render();
      }, 1400);
      return;
    }

    upload.status = 'failed';
    upload.error = readXhrError(xhr, `上传失败：${upload.fileName}`);
    render();
  });

  xhr.addEventListener('error', () => {
    upload.status = 'failed';
    upload.error = '上传连接异常';
    render();
  });

  xhr.addEventListener('abort', () => {
    upload.status = 'failed';
    upload.error = '上传已取消';
    render();
  });

  xhr.send(form);
}

function readXhrError(xhr: XMLHttpRequest, fallback: string): string {
  try {
    const data = JSON.parse(xhr.responseText || '{}') as { error?: string };
    return data.error || fallback;
  } catch {
    return fallback;
  }
}

function retryUpload(id: string): void {
  const upload = state.uploads.find((item) => item.id === id);
  if (!upload) return;
  uploadSingleFile(upload);
  render();
}

function discardUpload(id: string): void {
  state.uploads = state.uploads.filter((item) => item.id !== id);
  render();
}

function copyToClipboard(text: string, successText: string): void {
  navigator.clipboard
    .writeText(text)
    .then(() => toast(successText))
    .catch(() => toast('复制失败，请检查浏览器剪贴板权限'));
}

function copyRoomKey(): void {
  if (!state.roomKey) return;
  copyToClipboard(state.roomKey, 'Room 密钥已复制');
}

function getInviteText(): string {
  const inviter = state.self ? `${state.self.label} ${state.self.alias}` : state.alias;
  return `${inviter}邀请您加入${APP_NAME}，\n链接：${getMainLink()}\n密钥：${state.roomKey}`;
}

function copyInviteInfo(): void {
  if (!state.roomKey) return;
  copyToClipboard(getInviteText(), '邀请信息已复制');
}

async function createOneTimeInvite(): Promise<void> {
  if (!state.roomKey || state.status !== 'online') {
    state.inviteError = '请先进入 Room';
    render();
    return;
  }

  const previousCode = state.invite?.code;
  if (previousCode) await revokeInviteCode(previousCode);
  state.invite = undefined;
  state.inviteLoading = true;
  state.inviteError = '';
  clearInviteExpiryTimer();
  clearInviteTickTimer();
  render();

  try {
    const res = await fetch('/api/invites', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-device-id': state.deviceId,
      },
      body: JSON.stringify({ roomKey: state.roomKey }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '获取二维码失败');

    state.invite = {
      code: String(data.code),
      link: `${location.origin}${data.path}`,
      expiresAt: Number(data.expiresAt),
    };
    state.inviteError = '';
    scheduleInviteExpiry(state.invite.expiresAt);
  } catch (error) {
    state.invite = undefined;
    state.inviteError = error instanceof Error ? error.message : '获取二维码失败';
  } finally {
    state.inviteLoading = false;
    render();
  }
}

async function revokeInviteCode(code: string): Promise<void> {
  try {
    await fetch(`/api/invites/${code}`, {
      method: 'DELETE',
      headers: { 'x-device-id': state.deviceId },
    });
  } catch {
    // Best-effort cleanup; the server-side TTL still protects stale codes.
  }
}

async function closeInviteQrModal(): Promise<void> {
  const code = state.invite?.code;
  state.showInviteQr = false;
  resetInviteState();
  render();
  if (code) await revokeInviteCode(code);
}

function findMessageById(id: string): ClipboardMessage | undefined {
  return state.messages.find((item) => item.id === id);
}

function openImagePreview(id: string): void {
  const message = findMessageById(id);
  if (!message || message.revokedAt || message.type !== 'image') return;
  state.imagePreviewId = message.id;
  state.imagePreviewZoomed = false;
  render();
}

function closeImagePreview(): void {
  state.imagePreviewId = null;
  state.imagePreviewZoomed = false;
  if (document.fullscreenElement) {
    void document.exitFullscreen().catch(() => undefined);
  }
  render();
}

function toggleImagePreviewZoom(): void {
  if (!state.imagePreviewId) return;
  state.imagePreviewZoomed = !state.imagePreviewZoomed;
  render();
}

function toggleImagePreviewFullscreen(): void {
  const panel = document.querySelector<HTMLElement>('#imagePreviewPanel');
  if (!panel) return;
  if (document.fullscreenElement) {
    void document.exitFullscreen().catch(() => undefined);
    return;
  }
  void panel.requestFullscreen().catch(() => undefined);
}

function ensurePreviewMessage(): void {
  if (!state.imagePreviewId) return;
  const message = findMessageById(state.imagePreviewId);
  if (!message || message.revokedAt || message.type !== 'image') {
    state.imagePreviewId = null;
    state.imagePreviewZoomed = false;
  }
}

function downloadMessage(id: string): void {
  const message = findMessageById(id);
  if (!message || message.revokedAt) return;
  if (message.type !== 'image' && message.type !== 'file') return;
  const link = document.createElement('a');
  link.href = getFileDownloadUrl(message.id);
  link.download = message.fileName || (message.type === 'image' ? 'image' : 'file');
  link.rel = 'noreferrer';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

async function copyImageToClipboard(message: ClipboardMessage): Promise<void> {
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
    toast('当前浏览器不支持图片复制');
    return;
  }
  if (!isSecureContext) {
    toast('当前环境不支持图片复制');
    return;
  }

  try {
    const res = await fetch(getFileUrl(message.id), {
      headers: { 'x-device-id': state.deviceId },
    });
    if (!res.ok) throw new Error('copy failed');
    const blob = await res.blob();
    const mimeType = message.mimeType || blob.type || 'image/png';
    await navigator.clipboard.write([new ClipboardItem({ [mimeType]: blob })]);
    toast('图片已复制');
  } catch {
    toast('复制失败，请检查浏览器剪贴板权限');
  }
}

function copyMessage(id: string): void {
  const message = findMessageById(id);
  if (!message || message.revokedAt) return;

  if (message.type === 'text' && message.text) {
    copyToClipboard(message.text, '已复制文字');
    return;
  }

  if (message.type === 'image') {
    void copyImageToClipboard(message);
  }
}

function startEdit(id: string): void {
  const message = state.messages.find((item) => item.id === id);
  if (!message || message.type !== 'text' || !message.text) return;
  state.editingId = id;
  state.editingText = message.text;
  render();
}

function saveEdit(): void {
  if (!state.editingId) return;
  const text = state.editingText.trim();
  if (!text) {
    toast('内容不能为空');
    return;
  }
  sendWs({ type: 'editMessage', messageId: state.editingId, text });
  state.editingId = null;
  state.editingText = '';
  render();
}

function cancelEdit(): void {
  state.editingId = null;
  state.editingText = '';
  render();
}

function revokeMessage(id: string): void {
  if (!confirm('确定撤回这条内容吗？')) return;
  sendWs({ type: 'revokeMessage', messageId: id });
}

function clearMessages(): void {
  if (state.messages.length === 0) {
    toast('当前剪切板为空');
    return;
  }
  if (!confirm('确定清空当前 Room 的全部剪切板内容吗？文件也会一并删除。')) return;
  sendWs({ type: 'clearMessages' });
}

function changeAlias(): void {
  const input = document.querySelector<HTMLInputElement>('#aliasInput');
  const normalized = (input?.value || '').trim().replace(/\s+/g, ' ');
  if (normalized.length > MAX_ALIAS_LENGTH) {
    toast(`别名不能超过 ${MAX_ALIAS_LENGTH} 个字符，修改失败`);
    return;
  }

  const alias = normalized || state.self?.label || state.alias;
  state.alias = alias;
  localStorage.setItem(STORAGE.alias, state.alias);
  sendWs({ type: 'updateAlias', alias: state.alias });
  toast('别名已更新');
}

function toggleTheme(): void {
  state.theme = state.theme === 'light' ? 'dark' : 'light';
  localStorage.setItem(STORAGE.theme, state.theme);
  render();
}

function themeIcon(): string {
  return state.theme === 'light' ? '☾' : '☀';
}

function themeTitle(): string {
  return state.theme === 'light' ? '切换到夜间模式' : '切换到日间模式';
}

function scrollToBottom(): void {
  window.setTimeout(() => {
    const list = document.querySelector<HTMLDivElement>('#messageList');
    if (list) list.scrollTop = list.scrollHeight;
  }, 0);
}

function getMessageListScrollState(): { top: number; atBottom: boolean } | null {
  const list = document.querySelector<HTMLDivElement>('#messageList');
  if (!list) return null;
  const distance = list.scrollHeight - list.scrollTop - list.clientHeight;
  return { top: list.scrollTop, atBottom: distance <= 8 };
}

function restoreMessageListScroll(stateSnapshot: { top: number; atBottom: boolean } | null): void {
  if (!stateSnapshot) return;
  const list = document.querySelector<HTMLDivElement>('#messageList');
  if (!list) return;
  if (stateSnapshot.atBottom) {
    list.scrollTop = list.scrollHeight;
    return;
  }
  list.scrollTop = Math.min(stateSnapshot.top, Math.max(0, list.scrollHeight - list.clientHeight));
}

function autoResizeTextarea(textarea: HTMLTextAreaElement): void {
  const maxHeight = Number(textarea.dataset.maxHeight || 180);
  textarea.style.height = 'auto';
  const next = Math.min(textarea.scrollHeight, maxHeight);
  textarea.style.height = `${next}px`;
  textarea.style.overflowY = textarea.scrollHeight > maxHeight ? 'auto' : 'hidden';
}

function applyTextareaAutosize(): void {
  document.querySelectorAll<HTMLTextAreaElement>('textarea.autosize').forEach(autoResizeTextarea);
}

function render(): void {
  const scrollState = state.view === 'room' ? getMessageListScrollState() : null;
  document.documentElement.dataset.theme = state.theme;
  document.title = APP_NAME;
  app.innerHTML = state.view === 'home' ? renderHome() : renderRoom();
  bindEvents();
  applyTextareaAutosize();
  restoreMessageListScroll(scrollState);
}

function renderThemeButton(): string {
  return `<button class="icon-btn theme-toggle" id="themeBtn" title="${themeTitle()}" aria-label="${themeTitle()}">${themeIcon()}</button>`;
}

function renderHome(): string {
  return `
    <main class="page home-page">
      <section class="panel hero-panel">
        <div class="topbar">
          <div>
            <div class="eyebrow">${APP_NAME}</div>
            <h1>跨设备云剪切板</h1>
          </div>
          ${renderThemeButton()}
        </div>
        <p class="hero-text">创建一个 Room，得到 32 位密钥。其他设备持有密钥后即可进入同一个剪切板，发送文字、图片和文件。</p>
        <div class="home-actions">
          <button class="primary-btn" id="createRoomBtn">创建 Room</button>
          <div class="join-box">
            <input id="joinKeyInput" type="password" value="${escapeAttr(state.joinKey)}" placeholder="输入 32 位 Room 密钥" maxlength="32" autocomplete="off" />
            <button class="secondary-btn" id="joinRoomBtn">加入</button>
          </div>
        </div>
        <div class="tips">
          <span>WS 实时通信</span>
          <span>Room 简单持久化</span>
          <span>10 分钟无人自动释放</span>
        </div>
      </section>
      ${state.toast ? `<div class="toast">${escapeHtml(state.toast)}</div>` : ''}
    </main>
  `;
}

function renderRoom(): string {
  const selfLabel = state.self ? `${state.self.label} · ${state.self.alias}` : '连接中';
  const statusText =
    state.status === 'online'
      ? '在线'
      : state.status === 'reconnecting'
        ? '重连中'
        : state.status === 'connecting'
          ? '连接中'
          : '离线';

  return `
    <main class="page room-page">
      <aside class="sidebar panel">
        <div class="room-title-row room-status-row">
          <div class="status-line" title="${escapeAttr(`${statusText} · ${selfLabel}`)}">
            <span class="dot ${state.status}"></span>
            <span class="status-text">${statusText}</span>
            <span class="status-sep">·</span>
            <span class="status-self">${escapeHtml(selfLabel)}</span>
          </div>
          ${renderThemeButton()}
        </div>

        <div class="key-actions key-actions-grid">
          <button class="secondary-btn" id="copyKeyBtn">复制密钥</button>
          <button class="secondary-btn" id="showQrBtn">二维码加入</button>
          <button class="secondary-btn" id="copyInviteBtn">复制邀请信息</button>
          <button class="ghost-btn danger-btn" id="clearMessagesBtn">清空剪切板</button>
          <button class="ghost-btn" id="leaveRoomBtn">离开</button>
        </div>

        <label class="field-label" for="aliasInput">我的别名</label>
        <div class="alias-row">
          <input id="aliasInput" value="${escapeAttr(state.alias)}" maxlength="${MAX_ALIAS_LENGTH}" />
          <button class="secondary-btn" id="aliasBtn">保存</button>
        </div>

        <div class="member-block">
          <div class="section-title">在线设备 ${state.members.length}</div>
          <div class="members">
            ${state.members.map(renderMember).join('') || '<div class="muted">暂无在线设备</div>'}
          </div>
        </div>
      </aside>

      <section class="chat panel" id="dropZone">
        <div class="chat-header">
          <div>
            <div class="eyebrow">${APP_NAME}</div>
            <h1>跨设备云剪切板</h1>
          </div>
          <label class="file-btn">
            上传文件
            <input id="fileInput" type="file" multiple />
          </label>
        </div>

        <div class="message-list" id="messageList">
          ${renderMessageListContent()}
        </div>

        ${renderUploadTray()}

        <div class="composer">
          <textarea class="autosize composer-input" id="textInput" rows="1" data-max-height="180" placeholder="输入文字，Enter 发送，Shift + Enter 换行">${escapeHtml(state.textDraft)}</textarea>
          <button class="primary-btn" id="sendBtn">发送</button>
        </div>
      </section>

      ${state.toast ? `<div class="toast">${escapeHtml(state.toast)}</div>` : ''}
    </main>
    ${state.showInviteQr ? renderInviteQrModal() : ''}
    ${state.imagePreviewId ? renderImagePreviewModal() : ''}
  `;
}

function renderMessageListContent(): string {
  if (state.messages.length === 0 && state.pendingTexts.length === 0) {
    return '<div class="empty">还没有内容。可以发送文字，也可以直接粘贴或拖入图片/文件。</div>';
  }

  return `${state.messages.map(renderMessage).join('')}${state.pendingTexts.map(renderPendingText).join('')}`;
}

function renderPendingText(message: PendingText): string {
  const meta = `${state.self?.label || '本机'} · ${state.alias} · ${formatTime(message.createdAt)} · ${
    message.status === 'sending' ? '发送中' : '发送失败'
  }`;

  return `
    <article class="message own pending ${message.status}">
      <div class="message-meta">${escapeHtml(meta)}</div>
      <div class="bubble text-bubble"><pre>${escapeHtml(message.text)}</pre></div>
      <div class="message-actions">
        ${message.status === 'failed' ? `<button data-retry-pending="${message.clientId}">重试</button>` : ''}
        <button data-discard-pending="${message.clientId}">${message.status === 'failed' ? '丢弃' : '取消'}</button>
      </div>
      ${message.error ? `<div class="pending-error">${escapeHtml(message.error)}</div>` : ''}
    </article>
  `;
}

function renderUploadTray(): string {
  if (state.uploads.length === 0) return '';

  return `
    <div class="upload-tray">
      ${state.uploads
        .map(
          (upload) => `
            <div class="upload-item ${upload.status}">
              <div class="upload-main">
                <div class="upload-name" title="${escapeAttr(upload.fileName)}">${escapeHtml(upload.fileName)}</div>
                <div class="upload-meta">${upload.status === 'done' ? '上传完成' : upload.status === 'failed' ? escapeHtml(upload.error || '上传失败') : `${upload.progress}% · ${formatSize(upload.size)}`}</div>
              </div>
              <div class="upload-progress" aria-hidden="true"><span style="width: ${upload.progress}%"></span></div>
              <div class="upload-actions">
                ${upload.status === 'failed' ? `<button data-retry-upload="${upload.id}">重试</button>` : ''}
                ${upload.status === 'failed' ? `<button data-discard-upload="${upload.id}">移除</button>` : ''}
              </div>
            </div>
          `,
        )
        .join('')}
    </div>
  `;
}

function createQrSvg(text: string): string {
  const modules = createQrModules(text);
  const quiet = 4;
  const size = modules.length + quiet * 2;
  const paths: string[] = [];

  modules.forEach((row, y) => {
    row.forEach((dark, x) => {
      if (dark) paths.push(`M${x + quiet} ${y + quiet}h1v1h-1z`);
    });
  });

  return `
    <svg viewBox="0 0 ${size} ${size}" role="img" aria-label="Room 加入二维码">
      <rect width="${size}" height="${size}" fill="#ffffff"></rect>
      <path d="${paths.join(' ')}" fill="#000000"></path>
    </svg>
  `;
}

function createQrModules(text: string): boolean[][] {
  const version = 6;
  const size = 21 + (version - 1) * 4;
  const dataCodewordCount = 136;
  const blockDataCodewordCount = 68;
  const eccCodewordCount = 18;
  const bytes = Array.from(new TextEncoder().encode(text));
  if (bytes.length > 134) throw new Error('invite link is too long for QR version 6');

  const modules = Array.from({ length: size }, () => Array<boolean>(size).fill(false));
  const isFunction = Array.from({ length: size }, () => Array<boolean>(size).fill(false));
  const setFunction = (x: number, y: number, dark: boolean): void => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    modules[y][x] = dark;
    isFunction[y][x] = true;
  };

  const drawFinder = (x: number, y: number): void => {
    for (let dy = -1; dy <= 7; dy += 1) {
      for (let dx = -1; dx <= 7; dx += 1) {
        const xx = x + dx;
        const yy = y + dy;
        const inFinder = dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6;
        const dark = inFinder && (dx === 0 || dx === 6 || dy === 0 || dy === 6 || (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4));
        setFunction(xx, yy, dark);
      }
    }
  };

  drawFinder(0, 0);
  drawFinder(size - 7, 0);
  drawFinder(0, size - 7);

  for (let i = 8; i < size - 8; i += 1) {
    const dark = i % 2 === 0;
    setFunction(i, 6, dark);
    setFunction(6, i, dark);
  }

  for (let dy = -2; dy <= 2; dy += 1) {
    for (let dx = -2; dx <= 2; dx += 1) {
      const distance = Math.max(Math.abs(dx), Math.abs(dy));
      setFunction(34 + dx, 34 + dy, distance === 0 || distance === 2);
    }
  }

  drawFormatBits(modules, isFunction, size);
  setFunction(8, 4 * version + 9, true);

  const dataCodewords = makeQrDataCodewords(bytes, dataCodewordCount);
  const blocks = [dataCodewords.slice(0, blockDataCodewordCount), dataCodewords.slice(blockDataCodewordCount)];
  const eccBlocks = blocks.map((block) => makeReedSolomonRemainder(block, eccCodewordCount));
  const codewords: number[] = [];

  for (let i = 0; i < blockDataCodewordCount; i += 1) {
    for (const block of blocks) codewords.push(block[i]);
  }
  for (let i = 0; i < eccCodewordCount; i += 1) {
    for (const block of eccBlocks) codewords.push(block[i]);
  }

  let bitIndex = 0;
  let upward = true;
  const totalBits = codewords.length * 8;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right -= 1;
    for (let vertical = 0; vertical < size; vertical += 1) {
      const y = upward ? size - 1 - vertical : vertical;
      for (let offset = 0; offset < 2; offset += 1) {
        const x = right - offset;
        if (isFunction[y][x]) continue;
        const bit = bitIndex < totalBits && ((codewords[Math.floor(bitIndex / 8)] >>> (7 - (bitIndex % 8))) & 1) === 1;
        bitIndex += 1;
        modules[y][x] = (x + y) % 2 === 0 ? !bit : bit;
      }
    }
    upward = !upward;
  }

  drawFormatBits(modules, isFunction, size);
  return modules;
}

function drawFormatBits(modules: boolean[][], isFunction: boolean[][], size: number): void {
  const format = 0b111011111000100;
  const set = (x: number, y: number, bitIndex: number): void => {
    modules[y][x] = ((format >>> bitIndex) & 1) === 1;
    isFunction[y][x] = true;
  };

  for (let i = 0; i <= 5; i += 1) set(8, i, i);
  set(8, 7, 6);
  set(8, 8, 7);
  set(7, 8, 8);
  for (let i = 9; i < 15; i += 1) set(14 - i, 8, i);
  for (let i = 0; i < 8; i += 1) set(size - 1 - i, 8, i);
  for (let i = 8; i < 15; i += 1) set(8, size - 15 + i, i);
  modules[size - 8][8] = true;
  isFunction[size - 8][8] = true;
}

function makeQrDataCodewords(bytes: number[], dataCodewordCount: number): number[] {
  const bits: number[] = [];
  const appendBits = (value: number, length: number): void => {
    for (let i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
  };

  appendBits(0b0100, 4);
  appendBits(bytes.length, 8);
  bytes.forEach((byte) => appendBits(byte, 8));

  const capacityBits = dataCodewordCount * 8;
  for (let i = 0; i < 4 && bits.length < capacityBits; i += 1) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const codewords: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    codewords.push(bits.slice(i, i + 8).reduce((value, bit) => (value << 1) | bit, 0));
  }
  for (let pad = 0xec; codewords.length < dataCodewordCount; pad = pad === 0xec ? 0x11 : 0xec) {
    codewords.push(pad);
  }

  return codewords;
}

function makeReedSolomonRemainder(data: number[], degree: number): number[] {
  const divisor = makeReedSolomonDivisor(degree);
  const result = Array<number>(degree).fill(0);

  for (const byte of data) {
    const factor = byte ^ result.shift()!;
    result.push(0);
    divisor.forEach((coefficient, index) => {
      result[index] ^= finiteFieldMultiply(coefficient, factor);
    });
  }

  return result;
}

function makeReedSolomonDivisor(degree: number): number[] {
  const result = Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;

  for (let i = 0; i < degree; i += 1) {
    for (let j = 0; j < degree; j += 1) {
      result[j] = finiteFieldMultiply(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = finiteFieldMultiply(root, 2);
  }

  return result;
}

function finiteFieldMultiply(x: number, y: number): number {
  if (x === 0 || y === 0) return 0;
  const { exp, log } = getFiniteFieldTables();
  return exp[(log[x] + log[y]) % 255];
}

function getFiniteFieldTables(): { exp: number[]; log: number[] } {
  if (finiteFieldTables) return finiteFieldTables;

  const exp = Array<number>(255);
  const log = Array<number>(256).fill(0);
  let value = 1;

  for (let i = 0; i < 255; i += 1) {
    exp[i] = value;
    log[value] = i;
    value <<= 1;
    if (value & 0x100) value ^= 0x11d;
  }

  finiteFieldTables = { exp, log };
  return finiteFieldTables;
}

function renderInviteQrModal(): string {
  const invite = state.invite && state.invite.expiresAt > Date.now() ? state.invite : undefined;
  const secondsLeft = invite ? Math.max(0, Math.ceil((invite.expiresAt - Date.now()) / 1000)) : 0;
  return `
    <div class="modal-backdrop" role="presentation" id="inviteQrBackdrop">
      <section class="modal-panel qr-panel" role="dialog" aria-modal="true" aria-label="二维码加入">
        <div class="modal-head">
          <div>
            <div class="eyebrow">邀请加入</div>
            <h2>扫码加入 Room</h2>
          </div>
          <button class="icon-btn" id="closeQrBtn" aria-label="关闭">×</button>
        </div>
        <div class="qr-code ${invite ? '' : 'qr-empty'}">
          ${invite ? createQrSvg(invite.link) : `<div>${state.inviteLoading ? '二维码生成中' : escapeHtml(state.inviteError || '二维码 2 分钟内有效，扫码一次后失效')}</div>`}
        </div>
        <div class="invite-link" title="${escapeAttr(invite?.link || '')}">
          ${invite ? `<span>${escapeHtml(invite.link)}</span><strong>${secondsLeft}s</strong>` : `<span>${escapeHtml(state.inviteError || '等待一次性二维码')}</span>`}
        </div>
        <div class="modal-actions">
          <button class="secondary-btn" id="createInviteBtn" ${state.inviteLoading ? 'disabled' : ''}>${state.inviteLoading ? '获取中' : invite ? '重新获取' : '获取二维码'}</button>
          ${invite ? '<button class="primary-btn" id="copyQrInviteLinkBtn">复制二维码链接</button>' : ''}
        </div>
      </section>
    </div>
  `;
}

function renderImagePreviewModal(): string {
  const message = state.imagePreviewId ? findMessageById(state.imagePreviewId) : undefined;
  if (!message || message.type !== 'image' || message.revokedAt) return '';
  const fileUrl = getFileUrl(message.id);

  return `
    <div class="modal-backdrop image-backdrop" role="presentation" id="imagePreviewBackdrop">
      <section class="image-preview-panel" role="dialog" aria-modal="true" aria-label="图片预览" id="imagePreviewPanel">
        <div class="image-preview-toolbar">
          <button class="icon-btn" id="imagePreviewZoomBtn" aria-label="放大镜"><span class="material-symbols-rounded" aria-hidden="true">zoom_in</span></button>
          <button class="icon-btn" id="imagePreviewFullscreenBtn" aria-label="全屏"><span class="material-symbols-rounded" aria-hidden="true">fullscreen</span></button>
          <button class="icon-btn" id="imagePreviewCloseBtn" aria-label="关闭"><span class="material-symbols-rounded" aria-hidden="true">close</span></button>
        </div>
        <div class="image-preview-body ${state.imagePreviewZoomed ? 'zoomed' : ''}">
          <img src="${fileUrl}" alt="${escapeAttr(message.fileName || 'image')}" />
        </div>
      </section>
    </div>
  `;
}

function renderMember(member: Member): string {
  const isSelf = member.deviceId === state.deviceId;
  return `
    <div class="member ${isSelf ? 'self' : ''}">
      <span class="badge">${escapeHtml(member.label)}</span>
      <span>${escapeHtml(member.alias)}</span>
    </div>
  `;
}

function renderMessage(message: ClipboardMessage): string {
  const own = message.senderDeviceId === state.deviceId;
  const meta = `${escapeHtml(message.senderLabel)} · ${escapeHtml(message.senderAlias)} · ${formatTime(message.createdAt)}${message.editedAt ? ' · 已修改' : ''}`;
  const typeClass = `${message.type}-message`;

  if (message.revokedAt) {
    return `
      <article class="message ${own ? 'own' : ''} revoked">
        <div class="message-meta">${meta}</div>
        <div class="bubble">该内容已撤回</div>
      </article>
    `;
  }

  const body = state.editingId === message.id ? renderEditingBox() : renderMessageBody(message);
  const canEdit = own && message.type === 'text';
  const actions: string[] = [];

  if (message.type === 'text') {
    actions.push(`<button data-copy="${escapeAttr(message.id)}">复制</button>`);
    if (canEdit) actions.push(`<button data-edit="${escapeAttr(message.id)}">修改</button>`);
  }

  if (message.type === 'image') {
    actions.push(`<button data-copy="${escapeAttr(message.id)}">复制</button>`);
    actions.push(`<button data-download="${escapeAttr(message.id)}">下载</button>`);
  }

  if (message.type === 'file') {
    actions.push(`<button data-download="${escapeAttr(message.id)}">下载</button>`);
  }

  if (own) actions.push(`<button data-revoke="${escapeAttr(message.id)}">撤回</button>`);
  const actionsHtml = actions.length ? `<div class="message-actions">${actions.join('')}</div>` : '';

  return `
    <article class="message ${typeClass} ${own ? 'own' : ''}">
      <div class="message-meta">${meta}</div>
      <div class="bubble ${message.type === 'text' ? 'text-bubble' : ''}">${body}</div>
      ${actionsHtml}
    </article>
  `;
}

function renderMessageBody(message: ClipboardMessage): string {
  if (message.type === 'text') {
    return `<pre>${escapeHtml(message.text)}</pre>`;
  }

  if (message.type === 'image') {
    return `
      <div class="file-shell image-shell" data-preview="${escapeAttr(message.id)}">
        <img src="${getFileUrl(message.id)}" alt="${escapeAttr(message.fileName || 'image')}" />
        <div class="file-overlay">预览</div>
      </div>
      <div class="file-meta">${escapeHtml(message.fileName || 'image')} · ${formatSize(message.size)}</div>
    `;
  }

  return `
    <div class="file-shell" data-download="${escapeAttr(message.id)}">
      <div class="file-card">
        <span class="file-icon">FILE</span>
        <span>
          <strong>${escapeHtml(message.fileName || 'file')}</strong>
          <small>${escapeHtml(message.mimeType || 'unknown')} · ${formatSize(message.size)}</small>
        </span>
      </div>
      <div class="file-overlay">下载文件</div>
    </div>
  `;
}

function renderEditingBox(): string {
  return `
    <div class="edit-box">
      <textarea class="autosize" id="editInput" rows="1" data-max-height="220">${escapeHtml(state.editingText)}</textarea>
      <div>
        <button class="secondary-btn" id="saveEditBtn">保存</button>
        <button class="ghost-btn" id="cancelEditBtn">取消</button>
      </div>
    </div>
  `;
}

function bindEvents(): void {
  document.querySelector('#themeBtn')?.addEventListener('click', toggleTheme);
  document.querySelector('#createRoomBtn')?.addEventListener('click', () => void createRoom());
  document.querySelector('#joinRoomBtn')?.addEventListener('click', () => void joinRoom());
  document.querySelector('#leaveRoomBtn')?.addEventListener('click', () => leaveRoom());
  document.querySelector('#copyKeyBtn')?.addEventListener('click', copyRoomKey);
  document.querySelector('#copyInviteBtn')?.addEventListener('click', copyInviteInfo);
  document.querySelector('#showQrBtn')?.addEventListener('click', () => {
    state.showInviteQr = true;
    render();
    void createOneTimeInvite();
  });
  document.querySelector('#closeQrBtn')?.addEventListener('click', () => {
    void closeInviteQrModal();
  });
  document.querySelector('#createInviteBtn')?.addEventListener('click', () => void createOneTimeInvite());
  document
    .querySelector('#copyQrInviteLinkBtn')
    ?.addEventListener('click', () => state.invite && copyToClipboard(state.invite.link, '二维码链接已复制'));
  document.querySelector('#clearMessagesBtn')?.addEventListener('click', clearMessages);
  document.querySelector('#aliasBtn')?.addEventListener('click', changeAlias);
  document.querySelector('#sendBtn')?.addEventListener('click', sendText);
  document.querySelector('#saveEditBtn')?.addEventListener('click', saveEdit);
  document.querySelector('#cancelEditBtn')?.addEventListener('click', cancelEdit);

  const joinKeyInput = document.querySelector<HTMLInputElement>('#joinKeyInput');
  joinKeyInput?.addEventListener('input', () => {
    state.joinKey = joinKeyInput.value;
  });
  joinKeyInput?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void joinRoom();
  });

  const textInput = document.querySelector<HTMLTextAreaElement>('#textInput');
  textInput?.addEventListener('input', () => {
    state.textDraft = textInput.value;
    autoResizeTextarea(textInput);
  });
  textInput?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      state.textDraft = textInput.value;
      sendText();
    }
  });

  const editInput = document.querySelector<HTMLTextAreaElement>('#editInput');
  editInput?.addEventListener('input', () => {
    state.editingText = editInput.value;
    autoResizeTextarea(editInput);
  });

  const fileInput = document.querySelector<HTMLInputElement>('#fileInput');
  fileInput?.addEventListener('change', () => {
    if (fileInput.files) void uploadFiles(fileInput.files);
    fileInput.value = '';
  });

  document.querySelectorAll<HTMLButtonElement>('[data-copy]').forEach((button) => {
    button.addEventListener('click', () => copyMessage(button.dataset.copy || ''));
  });
  document.querySelectorAll<HTMLButtonElement>('[data-edit]').forEach((button) => {
    button.addEventListener('click', () => startEdit(button.dataset.edit || ''));
  });
  document.querySelectorAll<HTMLButtonElement>('[data-revoke]').forEach((button) => {
    button.addEventListener('click', () => revokeMessage(button.dataset.revoke || ''));
  });
  document.querySelectorAll<HTMLButtonElement>('[data-retry-pending]').forEach((button) => {
    button.addEventListener('click', () => retryPendingText(button.dataset.retryPending || ''));
  });
  document.querySelectorAll<HTMLButtonElement>('[data-discard-pending]').forEach((button) => {
    button.addEventListener('click', () => discardPendingText(button.dataset.discardPending || ''));
  });
  document.querySelectorAll<HTMLButtonElement>('[data-retry-upload]').forEach((button) => {
    button.addEventListener('click', () => retryUpload(button.dataset.retryUpload || ''));
  });
  document.querySelectorAll<HTMLButtonElement>('[data-discard-upload]').forEach((button) => {
    button.addEventListener('click', () => discardUpload(button.dataset.discardUpload || ''));
  });

  document.querySelectorAll<HTMLElement>('[data-preview]').forEach((element) => {
    element.addEventListener('click', () => openImagePreview(element.dataset.preview || ''));
  });
  document.querySelectorAll<HTMLElement>('[data-download]').forEach((element) => {
    element.addEventListener('click', () => downloadMessage(element.dataset.download || ''));
  });

  document.querySelector('#imagePreviewBackdrop')?.addEventListener('click', (event) => {
    if (event.target !== event.currentTarget) return;
    closeImagePreview();
  });
  document.querySelector('#imagePreviewCloseBtn')?.addEventListener('click', closeImagePreview);
  document.querySelector('#imagePreviewZoomBtn')?.addEventListener('click', toggleImagePreviewZoom);
  document.querySelector('#imagePreviewFullscreenBtn')?.addEventListener('click', toggleImagePreviewFullscreen);

  document.querySelector('#inviteQrBackdrop')?.addEventListener('click', (event) => {
    if (event.target !== event.currentTarget) return;
    void closeInviteQrModal();
  });

  const dropZone = document.querySelector<HTMLDivElement>('#dropZone');
  dropZone?.addEventListener('dragover', (event) => {
    event.preventDefault();
    dropZone.classList.add('dragging');
  });
  dropZone?.addEventListener('dragleave', () => dropZone.classList.remove('dragging'));
  dropZone?.addEventListener('drop', (event) => {
    event.preventDefault();
    dropZone.classList.remove('dragging');
    if (event.dataTransfer?.files?.length) void uploadFiles(event.dataTransfer.files);
  });
}

window.addEventListener('paste', (event) => {
  if (state.view !== 'room') return;
  const files = event.clipboardData?.files;
  if (files?.length) {
    void uploadFiles(files);
    return;
  }

  const text = event.clipboardData?.getData('text');
  const active = document.activeElement;
  const isTyping = active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement;
  const trimmedText = text.trim();
  if (trimmedText && !isTyping) {
    queueTextMessage(trimmedText);
  }
});

window.addEventListener('popstate', () => {
  const inviteCode = getInviteCodeFromUrl();
  if (inviteCode) {
    void redeemInviteCode(inviteCode);
    return;
  }

  if (clearLegacyKeyUrlIfNeeded()) {
    leaveRoom({ updateUrl: false, clearSaved: false });
    toast('邀请链接已失效，请重新获取二维码');
    return;
  }

  if (location.pathname === '/room') {
    const savedKey = getStored(STORAGE.roomKey, LEGACY_STORAGE.roomKey) || '';
    if (isValidRoomKey(savedKey)) enterRoom(savedKey, { updateUrl: false });
    else leaveRoom({ updateUrl: false, clearSaved: true });
    return;
  }

  if (state.view === 'room') {
    leaveRoom({ updateUrl: false, clearSaved: true });
  } else {
    render();
  }
});

function boot(): void {
  syncDeviceCookie();
  const inviteCode = getInviteCodeFromUrl();
  if (inviteCode) {
    void redeemInviteCode(inviteCode);
    return;
  }

  if (clearLegacyKeyUrlIfNeeded()) {
    render();
    toast('邀请链接已失效，请重新获取二维码');
    return;
  }

  if (location.pathname === '/room') {
    const savedKey = getStored(STORAGE.roomKey, LEGACY_STORAGE.roomKey) || '';
    if (isValidRoomKey(savedKey)) {
      localStorage.setItem(STORAGE.roomKey, savedKey);
      enterRoom(savedKey, { updateUrl: false });
      return;
    }

    history.replaceState({ view: 'home' }, '', '/');
    toast('本地没有保存 Room 密钥，请重新创建或加入 Room');
    return;
  }

  render();
}

boot();
