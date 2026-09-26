import { createServer } from 'node:http';

const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Builder Bob · deployment test</title>
<style>body{font:18px system-ui,sans-serif;max-width:34rem;margin:12vh auto;padding:24px;color:#183128;background:#f4f7f4}h1{font-size:2rem}button{font:inherit;background:#205d43;color:white;border:0;border-radius:8px;padding:12px 20px;cursor:pointer}button:disabled{opacity:.6}#result{min-height:2em;font-weight:600}small{color:#53655d}</style></head>
<body><small>Builder Bob · connection test</small><h1>Send Ping. Get Pong.</h1>
<p>This checks that your deployed service can receive a request and reply.</p>
<button id="ping">Send Ping</button><p id="result" role="status" aria-live="polite"></p>
<small>This page uses no AI and collects no project files.</small>
<script>
const button = document.querySelector('#ping');
const result = document.querySelector('#result');
button.addEventListener('click', async () => {
  button.disabled = true;
  result.textContent = 'Sending Ping…';
  try {
    const response = await fetch('/ping', {method:'POST'});
    if (!response.ok) throw new Error('Request failed');
    const message = await response.text();
    if (message !== 'Pong') throw new Error('Unexpected response');
    result.textContent = 'Pong — the server replied.';
  } catch {
    result.textContent = 'No reply. Please try again.';
  } finally { button.disabled = false; }
});
</script></body></html>`;

const server = createServer((request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  if (request.method === 'GET' && request.url === '/') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(page);
  } else if (request.method === 'POST' && request.url === '/ping') {
    request.resume();
    response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Pong');
  } else if (request.method === 'GET' && request.url === '/health') {
    response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('ok');
  } else {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
  }
});

server.listen(Number(process.env.PORT || 3000), '0.0.0.0', () => {
  console.log('Deployment test listening on port ' + server.address().port);
});
process.on('SIGTERM', () => server.close());
