// 配布用 zip を作る。--publish を付けると GitHub Releases にも公開する。
//   npm run release              … release/ に zip を作るだけ
//   npm run release -- --publish … タグを打って Release を作り、zip を添付する
//
// 開発中に Chrome が読み込んでいる dist/ を書き換えないよう、release/ の中にビルドする。

import { execFileSync, execSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const version = pkg.version;
const tag = `v${version}`;
const publish = process.argv.includes('--publish');
const releaseDir = resolve('release');
const buildDir = join(releaseDir, `who-said-${version}`);
const zipPath = join(releaseDir, `who-said-${version}.zip`);

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', ...opts });
const git = (...args) => run('git', args).trim();
function fail(message) {
  console.error(`中止: ${message}`);
  process.exit(1);
}

function listFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? listFiles(p) : [p];
  });
}

/** zip を書く。Windows の Compress-Archive は区切りに \ を使う場合があるので、/ を保証するため自前で組む */
function writeZip(sourceDir, target) {
  const parts = [];
  const central = [];
  let offset = 0;
  const entries = listFiles(sourceDir).map((p) => ({ path: p, name: relative(sourceDir, p).split(sep).join('/') }));
  entries.sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const { path, name } of entries) {
    const data = readFileSync(path);
    const packed = deflateRawSync(data, { level: 9 });
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const common = Buffer.alloc(26);
    common.writeUInt16LE(20, 0); // 展開に必要なバージョン
    common.writeUInt16LE(0x0800, 2); // ファイル名は UTF-8
    common.writeUInt16LE(8, 4); // deflate
    common.writeUInt16LE(0, 6); // 時刻は固定
    common.writeUInt16LE(0x21, 8); // 1980-01-01
    common.writeUInt32LE(crc, 10);
    common.writeUInt32LE(packed.length, 14);
    common.writeUInt32LE(data.length, 18);
    common.writeUInt16LE(nameBytes.length, 22);
    common.writeUInt16LE(0, 24);
    const local = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), common, nameBytes]);
    parts.push(local, packed);
    // コメント長・ディスク番号・内部属性・外部属性(各 0)の後ろにローカルヘッダの位置
    const tail = Buffer.alloc(14);
    tail.writeUInt32LE(offset, 10);
    central.push(Buffer.concat([Buffer.from([0x50, 0x4b, 0x01, 0x02, 20, 0]), common, tail, nameBytes]));
    offset += local.length + packed.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  writeFileSync(target, Buffer.concat([...parts, centralBytes, end]));
  return entries.map((e) => e.name);
}

function changelogSection() {
  const text = readFileSync('CHANGELOG.md', 'utf8');
  const start = text.indexOf(`## ${version}\n`) >= 0 ? text.indexOf(`## ${version}\n`) : text.indexOf(`## ${version}\r\n`);
  if (start < 0) fail(`CHANGELOG.md に ${version} の節がありません`);
  const body = text.slice(start).replace(/^.*\r?\n/, '');
  const next = body.search(/^## /m);
  return (next < 0 ? body : body.slice(0, next)).trim();
}

const notes = changelogSection();

if (publish) {
  if (git('status', '--porcelain')) fail('コミットしていない変更があります');
  if (git('rev-parse', '--abbrev-ref', 'HEAD') !== 'main') fail('main ブランチで実行してください');
  git('fetch', 'origin', 'main', '--tags');
  if (git('rev-parse', 'HEAD') !== git('rev-parse', 'origin/main')) fail('main が origin と一致していません。先に push してください');
  const existing = run('git', ['tag', '--list', tag]).trim();
  if (existing && git('rev-list', '-n', '1', tag) !== git('rev-parse', 'HEAD')) fail(`${tag} は別のコミットを指しています`);
}

// npm は Windows では .cmd なのでシェル経由で起動する
execSync('npm run check', { stdio: 'inherit' });
rmSync(buildDir, { recursive: true, force: true });
mkdirSync(releaseDir, { recursive: true });
execSync(`npx vite build --outDir "${buildDir}" --emptyOutDir`, { stdio: 'inherit' });

const manifest = JSON.parse(readFileSync(join(buildDir, 'manifest.json'), 'utf8'));
if (manifest.version !== version) fail(`manifest の版 ${manifest.version} が package.json と違います`);
if (!manifest.key) fail('manifest に key がありません(拡張 ID が固定されません)');

const names = writeZip(buildDir, zipPath);
if (!names.includes('manifest.json')) fail('zip の直下に manifest.json がありません');
if (names.some((n) => n.includes('\\'))) fail('zip のパスに \\ が含まれています');
if (names.some((n) => n.endsWith('.pem'))) fail('zip に秘密鍵が含まれています');
console.log(`\n作成: ${relative(process.cwd(), zipPath)} (${names.length} ファイル, ${(statSync(zipPath).size / 1024).toFixed(0)} KB)`);

if (publish) {
  const notesFile = join(releaseDir, 'notes.md');
  writeFileSync(notesFile, notes);
  run('gh', ['release', 'create', tag, zipPath, '--target', 'main', '--title', `Who Said ${version}`, '--notes-file', notesFile], {
    stdio: 'inherit',
  });
} else {
  console.log('公開するには: npm run release -- --publish');
}
