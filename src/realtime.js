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

    // "Fulano está digitando" na conversa X (repassado aos outros, some sozinho após 4s)
    socket.on('typing', ({ conversation_id, active }) => {
      const id = Number(conversation_id);
      if (!id) return;
      socket.to('agents').emit('typing', { conversation_id: id, user_id: socket.user.id, name: socket.user.name, active: Boolean(active) });
    });

    socket.on('disconnect', () => {
      const s = online.get(socket.user.id);
      if (s) { s.delete(socket.id); if (!s.size) online.delete(socket.user.id); }
      if (!online.has(socket.user.id)) { touchLastOnline(socket.user.id); broadcast('presence', { user_id: socket.user.id, online: false, last_online_at: new Date().toISOString() }); }
    });
  });

  return io;
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

module.exports = { init, broadcast, toUser, presenceList, isOnline };
