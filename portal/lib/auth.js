'use strict';
const { ADMIN_USER, ADMIN_PASS } = require('./config');

function requireAdmin(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="ClawStack"');
    return res.status(401).send('Unauthorized');
  }
  const [user, pass] = Buffer.from(auth.slice(6), 'base64').toString().split(':');
  if (user === ADMIN_USER && pass === ADMIN_PASS) return next();
  res.status(401).send('Invalid credentials');
}

// Returns true if request carries valid admin Basic auth OR a matching instance Bearer token.
function checkAuth(req, instanceToken) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Basic ')) {
    const [user, pass] = Buffer.from(auth.slice(6), 'base64').toString().split(':');
    if (user === ADMIN_USER && pass === ADMIN_PASS) return true;
  }
  if (instanceToken && auth.startsWith('Bearer ') && auth.slice(7) === instanceToken) return true;
  return false;
}

module.exports = { requireAdmin, checkAuth };
