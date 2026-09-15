const jwt = require('jsonwebtoken');
const config = require('../config');
const db = require('../db');

const COOKIE_NAME = 'sos_token';

function signToken(user) {
  return jwt.sign({ sub: user.id, role: user.role }, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn,
    algorithm: 'HS256',
  });
}

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'strict',
    secure: config.isProd,
    path: '/',
    maxAge: 1000 * 60 * 60 * 24, // 24h (o JWT expira antes)
  };
}

function verifyToken(token) {
  return jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
}

async function loadUserFromToken(token) {
  if (!token) return null;
  let payload;
  try {
    payload = verifyToken(token);
  } catch {
    return null;
  }
  const { rows } = await db.query(
    'SELECT id, name, email, role, active, avatar_media_id, signature FROM users WHERE id = $1 AND active = TRUE',
    [payload.sub]
  );
  return rows[0] || null;
}

/** Exige usuário autenticado (cookie httpOnly com JWT). */
async function requireAuth(req, res, next) {
  try {
    const user = await loadUserFromToken(req.cookies[COOKIE_NAME]);
    if (!user) return res.status(401).json({ error: 'Não autenticado' });
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Acesso restrito a administradores' });
  next();
}

/**
 * Proteção CSRF para a API JSON: toda requisição que altera estado precisa
 * do header X-Requested-With, que navegadores não enviam cross-origin sem CORS.
 */
function requireCsrfHeader(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('X-Requested-With') !== 'XMLHttpRequest') {
    return res.status(403).json({ error: 'Requisição inválida (CSRF)' });
  }
  next();
}

/** Redireciona páginas HTML protegidas para o login quando não há sessão. */
async function requirePageAuth(req, res, next) {
  try {
    const user = await loadUserFromToken(req.cookies[COOKIE_NAME]);
    if (!user) return res.redirect('/login.html');
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = {
  COOKIE_NAME,
  signToken,
  cookieOptions,
  loadUserFromToken,
  requireAuth,
  requireAdmin,
  requireCsrfHeader,
  requirePageAuth,
};
