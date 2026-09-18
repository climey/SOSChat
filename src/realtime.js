const { Server } = require('socket.io');
const cookie = require('cookie');
const { COOKIE_NAME, loadUserFromToken } = require('./middleware/auth');
const db = require('./db');

/** Marca no banco a última vez que o atendente esteve conectado (o painel Equipe usa isso). */
function touchLastOnline(userId) {
  db.query('UPDATE users SET last_online_at = NOW() WHERE id = $1', [userId]).catch(() => {});
}

let io = null;
const online = new Map(); // userId -> Set(socket ids)
const typing = new Map(); // conversationId -> Map(userId -> { name, at })
const viewers = new Map(); // conversationId -> Map(userId -> { name, avatar, sockets:Set })

function init(httpServer) {
  io = new Server(httpServer, { cors: false });

  // Autentica o socket pelo mesmo cookie da API
  io.use(async (socket, next) => {
    try {
      const parsed = cookie.parse(socket.handshake.headers.cookie || '');
      const user = await loadUserFromToken(parsed[COOKIE_NAME]);
      if (!user) return next(new Error('unauthorized'));
      socket.user = user;
      next();
    } catch (err) {
      next(err);
    }
  });

  io.on('connection', (socket) => {
    socket.join('agents');
    socket.join(`user:${socket.user.id}`);
    const set = online.get(socket.user.id) || new Set();
    set.add(socket.id);
    online.set(socket.user.id, set);
    touchLastOnline(socket.user.id);
    broadcast('presence', { user_id: socket.user.id, online: true, availability: socket.user.availability || 'available' });
    socket.emit('presence:all', presenceList());

    /** Quem está com a conversa aberta agora (para ninguém responder em cima do outro). */
    function setViewing(conversationId) {
      const prev = socket.viewingId || null;
      if (prev === conversationId) return;
      if (prev) {
        const m = viewers.get(prev);
        const entry = m && m.get(socket.user.id);
        if (entry) {
          entry.sockets.delete(socket.id);
          if (!entry.sockets.size) m.delete(socket.user.id);
          if (!m.size) viewers.delete(prev);
          broadcast('viewers', { conversation_id: prev, users: viewerList(prev) });
        }
      }
      socket.viewingId = conversationId;
      if (conversationId) {
        const m = viewers.get(conversationId) || new Map();
        const entry = m.get(socket.user.id) || { name: socket.user.name, avatar: socket.user.avatar_media_id || null, sockets: new Set() };
        entry.sockets.add(socket.id);
        m.set(socket.user.id, entry);
        viewers.set(conversationId, m);
        broadcast('viewers', { conversation_id: conversationId, users: viewerList(conversationId) });
      }
    }
    socket.on('viewing', ({ conversation_id }) => setViewing(Number(conversation_id) || null));
    socket.emit('viewers:all', allViewers());

    // "Fulano está digitando" na conversa X (repassado aos outros, some sozinho após 4s)
    socket.on('typing', ({ conversation_id, active }) => {
      const id = Number(conversation_id);
      if (!id) return;
      socket.to('agents').emit('typing', { conversation_id: id, user_id: socket.user.id, name: socket.user.name, active: Boolean(active) });
    });

    socket.on('disconnect', () => {
      setViewing(null);
      const s = online.get(socket.user.id);
      if (s) { s.delete(socket.id); if (!s.size) online.delete(socket.user.id); }
      if (!online.has(socket.user.id)) { touchLastOnline(socket.user.id); broadcast('presence', { user_id: socket.user.id, online: false, last_online_at: new Date().toISOString() }); }
    });
  });

  return io;
}

/** Atendentes com a conversa aberta, sem repetir quem está em mais de uma aba. */
function viewerList(conversationId) {
  const m = viewers.get(conversationId);
  return m ? [...m.entries()].map(([id, v]) => ({ id, name: v.name, avatar: v.avatar })) : [];
}
function allViewers() {
  const out = {};
  for (const id of viewers.keys()) out[id] = viewerList(id);
  return out;
}

function presenceList() {
  return [...online.keys()];
}

function isOnline(userId) {
  return online.has(userId);
}

/** Envia um evento para todos os atendentes conectados. */
function broadcast(event, payload) {
  if (!io) return;
  io.to('agents').emit(event, payload);
}

/** Envia um evento só para um atendente (todas as abas dele). */
function toUser(userId, event, payload) {
  if (!io) return;
  io.to(`user:${userId}`).emit(event, payload);
}

module.exports = { init, broadcast, toUser, presenceList, isOnline, viewerList, allViewers };
