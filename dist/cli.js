import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const HELP = `MCT — Minecraft observation and control for AI agents

Usage: mct <group> <action> [path|session] [--option value]
       mct observe <session> | mct capture <session>

map      open PATH --version VERSION | list | inspect ID | reload ID
         resources ID --resource-pack PACK.zip [--assets-jar CLIENT.jar]
         view ID | camera ID --position x,y,z --target x,y,z
         slice ID --axis y --at N | capture ID [--cut-y N] | close ID
         stage ID --client CLIENT --accept-eula [--java-path JAVA]
         collisions ID --client CLIENT [--context-bounds JSON]
model    open PATH | inspect ID | camera ID --position x,y,z
         animation ID --clip NAME --time N | sample ID --clip NAME --from 0 --to 1 --frames 8
         capture ID | watch ID | reload ID | stop ID | close ID
player   connect HOST --version VERSION [--backend auto|bot|client] [--username NAME]
         list | attach DISCOVERY.json | observe ID | look ID --yaw RADIANS --pitch RADIANS
         move ID --position x,y,z | move ID --control forward --duration-ms 500
         interact ID --action activate | inventory ID [--operation select --slot 0..8]
         command ID --command TEXT
         capture ID | stop ID | disconnect ID
client   list [--directory PATH] | attach DISCOVERY.json | observe ID | capture ID
         input ID --key forward --duration-ms 500 | inventory ID | stop ID
interior check ID --inspection FILE | check --client CLIENT_ID --inspection FILE
         tour ID --inspection FILE --player BOT_ID
test     create --version VERSION --accept-eula [--world PATH]
         start ID [--java-path JAVA] | stop ID | logs ID | command ID --command TEXT | list
server   attach --host HOST --port 25575 --password VALUE (RCON)
session  list | close ID
job      list | status ID | cancel ID
bridge   config | list
doctor   [--refresh]
daemon   stop

Input: --data '{"field":value}' or --input JSON_FILE merges structured arguments.
       On Windows .cmd, prefer --input JSON_FILE to preserve JSON quotes.
       --async runs eligible operations as jobs; --timeout-ms controls request timeout.
       --state-dir PATH isolates daemon state. Default: PROJECT/.mct
       Map preview loads exact-version Java models/textures; --no-textures uses colored structure.
       Long jobs expose running/cancelling/cancelled; cancellation completes after cleanup.
Output: JSON on stdout, diagnostics on stderr, nonzero exit on failure.
Angles: player yaw/pitch use radians. XYZ values are world coordinates.
Captures: structural-preview / prismarine-viewer are approximate; minecraft-client is actual framebuffer.
`;
function scalar(text) {
    if (text === 'true')
        return true;
    if (text === 'false')
        return false;
    if (/^-?\d+(\.\d+)?$/.test(text))
        return Number(text);
    if (text.startsWith('{') || text.startsWith('[')) {
        try {
            return JSON.parse(text);
        }
        catch { }
    }
    return text;
}
function parse(argv) {
    const args = {}, positional = [];
    for (let i = 0; i < argv.length; i++) {
        const item = argv[i];
        if (!item.startsWith('--')) {
            positional.push(item);
            continue;
        }
        const [rawKey, ...equals] = item.slice(2).split('=');
        const key = rawKey.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        if (rawKey.startsWith('no-')) {
            args[rawKey.slice(3).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = false;
            continue;
        }
        args[key] = equals.length ? scalar(equals.join('=')) : argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? scalar(argv[++i]) : true;
    }
    return { args, positional };
}
async function connection(stateDir) {
    const file = path.join(stateDir, 'daemon.json');
    async function existing() { try {
        const info = JSON.parse(await fs.readFile(file, 'utf8'));
        const response = await fetch(`http://127.0.0.1:${info.port}/health`, { headers: { authorization: `Bearer ${info.token}` }, signal: AbortSignal.timeout(1500) });
        if (response.ok && (await response.json()).pid === info.pid)
            return info;
    }
    catch { } return null; }
    let info = await existing();
    if (info)
        return info;
    await fs.mkdir(stateDir, { recursive: true });
    const lockPath = path.join(stateDir, 'startup.lock');
    let lock;
    for (let attempt = 0; attempt < 200; attempt++) {
        info = await existing();
        if (info)
            return info;
        try {
            lock = await fs.open(lockPath, 'wx');
            await lock.writeFile(String(process.pid));
            break;
        }
        catch (error) {
            if (error.code !== 'EEXIST')
                throw error;
            const stat = await fs.stat(lockPath).catch(() => null);
            if (stat && Date.now() - stat.mtimeMs > 30000)
                await fs.unlink(lockPath).catch(() => { });
            await delay(100);
        }
    }
    if (!lock)
        throw Object.assign(new Error('Another CLI is still starting the daemon'), { code: 'DAEMON_START_BUSY' });
    try {
        info = await existing();
        if (info)
            return info;
        const log = await fs.open(path.join(stateDir, 'daemon.log'), 'a');
        const child = spawn(process.execPath, [path.join(root, 'dist', 'daemon.js')], { cwd: root, detached: true, windowsHide: true, env: { ...process.env, MCT_STATE_DIR: stateDir }, stdio: ['ignore', log.fd, log.fd] });
        child.unref();
        await log.close();
        for (let i = 0; i < 150; i++) {
            await delay(100);
            info = await existing();
            if (info)
                return info;
        }
        throw Object.assign(new Error(`Daemon failed to start; see ${path.join(stateDir, 'daemon.log')}`), { code: 'DAEMON_START_FAILED' });
    }
    finally {
        await lock.close();
        await fs.unlink(lockPath).catch(() => { });
    }
}
async function main() {
    const { args, positional } = parse(process.argv.slice(2));
    if (positional[0] === 'version' || args.version === true && positional.length === 0) {
        process.stdout.write('0.2.0\n');
        return;
    }
    if (args.help || positional.length === 0) {
        process.stdout.write(HELP);
        return;
    }
    if (args.version && positional[0] === 'version') {
        process.stdout.write('0.2.0\n');
        return;
    }
    let domain = positional[0], action = positional[1] || 'list';
    let rest = positional.slice(2);
    if (['observe', 'capture'].includes(domain)) {
        rest = positional.slice(1);
        action = domain;
    }
    if (domain === 'doctor')
        action = 'check';
    if (args.input)
        Object.assign(args, JSON.parse((await fs.readFile(path.resolve(args.input), 'utf8')).replace(/^\uFEFF/, '')));
    if (args.data)
        Object.assign(args, typeof args.data === 'string' ? JSON.parse(args.data) : args.data);
    if (rest[0] !== undefined) {
        if (['map', 'model'].includes(domain) && action === 'open' || ['client', 'player'].includes(domain) && action === 'attach')
            args.path = rest[0];
        else if (domain === 'player' && action === 'connect') {
            args.host = rest[0];
            args.server = rest[0];
        }
        else if (domain === 'job')
            args.job = rest[0];
        else
            args.session = rest[0];
    }
    for (const key of ['position', 'target', 'entry'])
        if (typeof args[key] === 'string' && args[key].includes(',')) {
            const v = args[key].split(',').map(Number);
            if (v.length !== 3 || v.some((x) => !Number.isFinite(x)))
                throw Object.assign(new Error(`${key} requires x,y,z`), { code: 'INVALID_ARGUMENT' });
            args[key] = { x: v[0], y: v[1], z: v[2] };
        }
    for (const key of ['path', 'inspection', 'world', 'assetsJar', 'assetRoot', 'resourcePack', 'directory'])
        if (typeof args[key] === 'string')
            args[key] = path.resolve(args[key]);
    if (Array.isArray(args.resourcePacks))
        args.resourcePacks = args.resourcePacks.map((file) => path.resolve(file));
    const stateDir = path.resolve(args.stateDir || process.env.MCT_STATE_DIR || path.join(root, '.mct'));
    delete args.stateDir;
    const info = await connection(stateDir);
    const response = await fetch(`http://127.0.0.1:${info.port}/rpc`, { method: 'POST', headers: { authorization: `Bearer ${info.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ domain, action, args }), signal: AbortSignal.timeout(Number(args.timeoutMs || 180000) + 5000) });
    const result = await response.json();
    process.stdout.write(`${JSON.stringify(result, null, args.compact ? 0 : 2)}\n`);
    if (!result.ok)
        process.exitCode = 1;
}
main().catch(error => { process.stdout.write(`${JSON.stringify({ ok: false, error: { code: error.code || 'CLI_ERROR', message: error.message } }, null, 2)}\n`); process.exitCode = 1; });
//# sourceMappingURL=cli.js.map