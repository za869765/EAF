const http = require('http');
const fs = require('fs');
const path = require('path');
const port = process.env.PORT || 3334;
const mime = { '.html':'text/html', '.css':'text/css', '.js':'application/javascript', '.json':'application/json', '.png':'image/png', '.ico':'image/x-icon' };
http.createServer((req, res) => {
  let fp = path.join(__dirname, req.url === '/' ? '/index.html' : req.url);
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': mime[path.extname(fp)] || 'text/plain' });
    res.end(data);
  });
}).listen(port, () => console.log('Server running on port ' + port));
