import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

export class Store {
  constructor(path) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, time TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL);');
    const keyPath = join(dirname(path), 'secret.key');
    if (!existsSync(keyPath)) writeFileSync(keyPath, randomBytes(32), { mode: 0o600 });
    this.key = readFileSync(keyPath);
  }
  get(key, fallback = null) { const row = this.db.prepare('SELECT value FROM kv WHERE key=?').get(key); return row ? JSON.parse(row.value) : fallback; }
  put(key, value) { this.db.prepare('INSERT INTO kv VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)); }
  audit(kind, payload) { this.db.prepare('INSERT INTO audit(time,kind,payload) VALUES (?,?,?)').run(new Date().toISOString(), kind, JSON.stringify(payload)); }
  events(limit = 300) { return this.db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?').all(limit).map(x => ({ id: x.id, time: x.time, kind: x.kind, ...JSON.parse(x.payload) })); }
  secret(name, value) {
    if (value === undefined) {
      const encrypted = this.get('secret:' + name);
      if (!encrypted) return null;
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(encrypted.iv, 'hex'));
      decipher.setAuthTag(Buffer.from(encrypted.tag, 'hex'));
      return Buffer.concat([decipher.update(Buffer.from(encrypted.data, 'hex')), decipher.final()]).toString();
    }
    if (!value) { this.db.prepare('DELETE FROM kv WHERE key=?').run('secret:' + name); return; }
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    this.put('secret:' + name, { iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), data: data.toString('hex') });
  }
  close() { this.db.close(); }
}
