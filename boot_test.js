// Boot test 3.12i : le serveur doit démarrer sans crash (sans clés API, réseau coupé),
// répondre en HTTP et logger sa bannière version. On le tue proprement après vérification.
const { spawn } = require('child_process');
const http = require('http');

const PORT = 18099;
const child = spawn('node', ['server.js'], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let out = '', err = '';
child.stdout.on('data', (d) => { out += d; });
child.stderr.on('data', (d) => { err += d; });

let crashed = false;
child.on('exit', (code) => {
  if (!done && code !== null && code !== 0) { crashed = true; }
});

let done = false;
function finish(ok, msg) {
  if (done) return;
  done = true;
  try { child.kill('SIGKILL'); } catch (_) {}
  console.log(msg);
  process.exit(ok ? 0 : 1);
}

setTimeout(() => {
  if (crashed) return finish(false, 'BOOT TEST : FAIL — crash au démarrage\n' + err.slice(0, 800));
  const req = http.get({ host: '127.0.0.1', port: PORT, path: '/' }, (res) => {
    const httpOk = res.statusCode >= 200 && res.statusCode < 500;
    res.resume();
    const banner = new RegExp(process.env.EXPECT_VERSION || "3\\.12").test(out);
    if (httpOk && banner) return finish(true, `BOOT TEST : PASS — HTTP ${res.statusCode}, bannière version détectée, zéro crash.`);
    return finish(false, `BOOT TEST : FAIL — HTTP ${res.statusCode}, bannière version ${banner ? 'OK' : 'ABSENTE'}\n--- stdout ---\n${out.slice(0, 600)}\n--- stderr ---\n${err.slice(0, 400)}`);
  });
  req.on('error', (e) => finish(false, 'BOOT TEST : FAIL — serveur HTTP injoignable : ' + e.message + '\n' + err.slice(0, 600)));
}, 3500);
