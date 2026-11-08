// A stand-in for Google's OAuth endpoints (W09 tests only; never used by the real server).
// It behaves like Google where it matters to us: codes are single use and bound to the
// client, redirect URI, PKCE challenge and nonce; a refresh token is only returned on the
// first consent for an account (or when the app asks `prompt=consent`); the user may
// refuse, or untick the Drive permission.
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';

const b64u = (b) => Buffer.from(b).toString('base64url');
const DRIVE = 'https://www.googleapis.com/auth/drive.file';

export async function startFakeGoogle({ clientId, clientSecret, host = '127.0.0.1', publicHost = 'localhost' }) {
  const codes = new Map();
  const consented = new Set();
  const state = {
    user: { sub: '1001', email: 'owner@example.com', email_verified: true, name: 'Owner' },
    deny: false,
    grantDrive: true,
    tokenStatus: 200,
    mutateClaims: null,
    authRequests: [],
    tokenRequests: [],
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    if (req.method === 'GET' && url.pathname === '/auth') {
      const p = Object.fromEntries(url.searchParams);
      state.authRequests.push(p);
      const back = new URL(p.redirect_uri);
      if (p.client_id !== clientId || p.response_type !== 'code' || p.code_challenge_method !== 'S256' || !p.code_challenge || !p.state) {
        back.searchParams.set('error', 'invalid_request');
      } else if (state.deny) {
        back.searchParams.set('error', 'access_denied');
      } else {
        const code = b64u(randomBytes(18));
        const scope = p.scope.split(' ').filter((s) => state.grantDrive || s !== DRIVE);
        codes.set(code, { p, user: { ...state.user }, scope: scope.map((s) => (s === 'email' ? 'https://www.googleapis.com/auth/userinfo.email' : s === 'profile' ? 'https://www.googleapis.com/auth/userinfo.profile' : s)).join(' ') });
        back.searchParams.set('code', code);
        back.searchParams.set('scope', scope.join(' '));
      }
      back.searchParams.set('state', p.state ?? '');
      res.writeHead(302, { Location: back.toString() });
      return res.end();
    }
    if (req.method === 'POST' && url.pathname === '/token') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const f = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8')));
      state.tokenRequests.push(f);
      const fail = (error) => {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error }));
      };
      if (state.tokenStatus !== 200) {
        res.writeHead(state.tokenStatus, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'server_error' }));
      }
      const c = codes.get(f.code);
      codes.delete(f.code);
      if (!c) return fail('invalid_grant');
      if (f.client_id !== clientId || f.client_secret !== clientSecret) return fail('invalid_client');
      if (f.grant_type !== 'authorization_code' || f.redirect_uri !== c.p.redirect_uri) return fail('invalid_grant');
      if (!f.code_verifier || b64u(createHash('sha256').update(f.code_verifier).digest()) !== c.p.code_challenge) return fail('invalid_grant');
      const now = Math.floor(Date.now() / 1000);
      let claims = { iss: 'https://accounts.google.com', azp: clientId, aud: clientId, sub: c.user.sub, email: c.user.email, email_verified: c.user.email_verified, name: c.user.name, nonce: c.p.nonce, iat: now, exp: now + 3600 };
      if (state.mutateClaims) claims = state.mutateClaims(claims);
      const giveRefresh = !consented.has(c.user.sub) || (c.p.prompt ?? '').split(' ').includes('consent');
      consented.add(c.user.sub);
      const body = {
        access_token: `ya29.fake-${b64u(randomBytes(12))}`,
        expires_in: 3599,
        token_type: 'Bearer',
        scope: c.scope,
        id_token: `${b64u(JSON.stringify({ alg: 'RS256', kid: 'fake' }))}.${b64u(JSON.stringify(claims))}.${b64u(randomBytes(32))}`,
        ...(giveRefresh ? { refresh_token: `1//fake-refresh-${b64u(randomBytes(24))}` } : {}),
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(body));
    }
    if (req.method === 'GET' && url.pathname === '/other-site') {
      // A plain page on another site (CSRF checks in the UI run).
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<!doctype html><title>Situs lain</title><p>situs lain</p>');
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => server.listen(0, host, r));
  const port = server.address().port;
  return {
    state,
    port,
    authUrl: `http://${publicHost}:${port}/auth`,
    tokenUrl: `http://127.0.0.1:${port}/token`,
    forget: (sub) => consented.delete(sub),
    close: () => new Promise((r) => server.close(() => r())),
  };
}
