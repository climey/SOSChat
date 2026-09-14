const { Server } = require('socket.io');
const cookie = require('cookie');
const { COOKIE_NAME, loadUserFromToken } = require('./middleware/auth');

let io = null;

function init(httpServer) {
  io = new Server(httpServer, {
    cors: false, // mesma origem
  });

  // Autentica o socket pelo mesmo cookie da API
  io.use(async (socket, next) => {
    try {
      const raw = socket.handshake.headers.cookie || '';
      const parsed = cookie.parse(raw);
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
  });

  return io;
}

/** Envia um evento para todos os atendentes conectados. */
function broadcast(event, payload) {
  if (!io) return;
  io.to('agents').emit(event, payload);
}

module.exports = { init, broadcast };
