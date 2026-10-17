import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { Application } from './app.js';
import { viewerHtml, vendor } from './viewer.js';
import { nativeViewerHtml } from './native-viewer.js';
const stateDir = path.resolve(process.env.MCT_STATE_DIR || '.mct');
await fs.mkdir(path.join(stateDir, 'artifacts'), { recursive: true });
const token = randomBytes(32).toString('hex'), viewKey = randomBytes(24).toString('hex');
const app = new Application({ stateDir, artifactDir: path.join(stateDir, 'artifacts') });
function same(a: string, b: string) { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); }
function json(res: http.ServerResponse, status: number, value: unknown) { const serialized=JSON.stringify(value,(_key,v)=>typeof v==='bigint'?v.toString():v); res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(serialized); }
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (req.headers.origin && req.headers.origin !== `http://127.0.0.1:${(server.address() as any).port}`) return json(res, 403, { error: { code: 'FORBIDDEN_ORIGIN' } });
    if (url.pathname.startsWith('/vendor/')) { const bytes=await vendor(path.basename(url.pathname));res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'private,max-age=3600' }); res.end(bytes); return; }
    if(url.pathname==='/native-view'||url.pathname==='/native-frame'){
      if(!same(url.searchParams.get('key')||'',viewKey))return json(res,401,{error:{code:'UNAUTHORIZED'}});
      if(url.pathname==='/native-view'){res.writeHead(200,{'content-type':'text/html; charset=utf-8','referrer-policy':'no-referrer','cache-control':'no-store'});res.end(nativeViewerHtml);}
      else{const bytes=await app.nativeFrame(url.searchParams.get('session')||'');res.writeHead(200,{'content-type':'image/png','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(bytes);}return;
    }
    if (url.pathname === '/viewer' || url.pathname === '/viewer-data') {
      if (!same(url.searchParams.get('key') || '', viewKey)) return json(res, 401, { error: { code: 'UNAUTHORIZED' } });
      if (url.pathname === '/viewer') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'referrer-policy': 'no-referrer' }); res.end(viewerHtml); }
      else {const controller=new AbortController();res.once('close',()=>{if(!res.writableEnded)controller.abort();});json(res, 200, await app.viewerData({ session: url.searchParams.get('session'), bounds: url.searchParams.has('bounds') ? JSON.parse(url.searchParams.get('bounds')!) : undefined,signal:controller.signal }));}return;
    }
    if (!same(req.headers.authorization || '', `Bearer ${token}`)) return json(res, 401, { error: { code: 'UNAUTHORIZED' } });
    if (url.pathname === '/health') return json(res, 200, { ok: true, pid: process.pid, protocol: 1 });
    if (url.pathname !== '/rpc' || req.method !== 'POST') return json(res, 404, { error: { code: 'NOT_FOUND' } });
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > 2_000_000) throw Object.assign(new Error('Request exceeds 2MB'), { code: 'REQUEST_TOO_LARGE' }); chunks.push(chunk); }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (body.domain === 'daemon' && body.action === 'stop') { json(res, 200, { ok: true, result: { stopping: true } }); setTimeout(() => void shutdown(), 50); return; }
    json(res, 200, { ok: true, result: await app.execute(body.domain, body.action || 'list', body.args || {}) });
  } catch (error: any) { if(res.headersSent){res.destroy();return;}json(res, 400, { ok: false, error: { code: error.code || (error instanceof SyntaxError ? 'INVALID_JSON' : 'INTERNAL_ERROR'), message: error.message, details: error.details } }); }
});
const wss = new WebSocketServer({ noServer: true, maxPayload: 100_000_000 });
server.on('upgrade', (req, socket, head) => {
  if (req.url !== '/bridge') { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, ws => {
    const timer = setTimeout(() => ws.close(1008, 'Authentication timeout'), 5000);
    ws.once('message', raw => { clearTimeout(timer); try { const hello = JSON.parse(String(raw)); if (!same(hello.token || '', token) || hello.kind !== 'blockbench') { ws.close(1008, 'Unauthorized'); return; } const peer = app.bridges.register(ws, hello); ws.send(JSON.stringify({ type: 'registered', id: peer.id, protocol: 1 })); } catch { ws.close(1008, 'Invalid handshake'); } });
  });
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const port = (server.address() as any).port;
app.viewerUrl = (session, args = {}) => `http://127.0.0.1:${port}/viewer?session=${encodeURIComponent(session)}&key=${viewKey}${args.bounds ? `&bounds=${encodeURIComponent(JSON.stringify(args.bounds))}` : ''}${args.cutY === undefined ? '' : `&cutY=${encodeURIComponent(args.cutY)}`}`;
app.nativeViewerUrl=session=>`http://127.0.0.1:${port}/native-view?session=${encodeURIComponent(session)}&key=${viewKey}`;
await fs.writeFile(path.join(stateDir, 'bridge-config.json'), JSON.stringify({ endpoint: `ws://127.0.0.1:${port}/bridge`, token, protocol: 1 }, null, 2));
await fs.writeFile(path.join(stateDir, 'daemon.json'), JSON.stringify({ pid: process.pid, port, token, protocol: 1, startedAt: new Date().toISOString() }));
let stopping = false;
async function shutdown() { if (stopping) return; stopping = true; await app.close(); for (const client of wss.clients) client.terminate(); wss.close(); server.close(); await fs.unlink(path.join(stateDir, 'daemon.json')).catch(() => {}); process.exit(0); }
process.on('SIGTERM', () => void shutdown()); process.on('SIGINT', () => void shutdown());
