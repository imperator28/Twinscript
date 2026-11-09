// Scan unpacked artifacts before compression; never print matched bytes.
const fs = require('node:fs');
const path = require('node:path');
const patterns = [/sk-[A-Za-z0-9]{32,}/, /sk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}/, /AIza[A-Za-z0-9_-]{35}/, /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/];
function scan(root) {
  let count = 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) { count += scan(file); continue; }
    if (!entry.isFile()) continue;
    if (/^\.env(?:\.|$)/.test(entry.name)) throw new Error(`Environment file in artifact: ${file}`);
    const fd = fs.openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(65536); let tail = '', n;
      while ((n = fs.readSync(fd, buffer)) > 0) {
        const text = tail + buffer.subarray(0, n).toString('latin1');
        if (patterns.some(pattern => pattern.test(text))) throw new Error(`Possible secret in artifact: ${file}`);
        tail = text.slice(-512);
      }
    } finally { fs.closeSync(fd); }
    count++;
  }
  return count;
}
if (require.main === module) {
  if (process.argv.length < 3) throw new Error('Pass one or more unpacked artifact directories');
  let files = 0;
  for (const root of process.argv.slice(2)) files += scan(root);
  console.log(`Scanned ${files} unpacked artifact files; no secret patterns found.`);
}
module.exports = { scan };
