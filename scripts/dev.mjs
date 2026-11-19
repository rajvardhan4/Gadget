import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import handler from '../api/portal.js';

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/portal.js', ['portal.js', 'text/javascript; charset=utf-8']],
  ['/portal.css', ['portal.css', 'text/css; charset=utf-8']],
]);

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/portal') {
    res.status = code => {
      res.statusCode = code;
      return res;
    };
    res.json = body => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(body));
    };
    try {
      if (req.method === 'POST') {
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 4_500_000) return res.status(413).json({ error: 'Request too large.' });
          chunks.push(chunk);
        }
        req.body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      }
      return handler(req, res);
    } catch {
      return res.status(400).json({ error: 'Invalid request.' });
    }
  }
  const asset = assets.get(url.pathname);
  if (!asset) {
    res.writeHead(404).end();
    return;
  }
  const [filename, mime] = asset;
  res.setHeader('Content-Type', mime);
  res.end(await readFile(new URL('../dist/' + filename, import.meta.url)));
});

server.listen(Number(process.env.PORT ?? 3000), '127.0.0.1', () => {
  console.log('Portal is ready at http://127.0.0.1:' + server.address().port);
});
