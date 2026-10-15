/**
 * Rebuild lib/wire.js from the upstream protocol sources.
 *
 * `lib/wire.js` is a *vendored bundle*: it is not written by this plugin, it is
 * esbuild output over the protocol packages of Z.ai's ZCode client. Keeping the
 * build here is what makes an upstream protocol change recoverable — without it
 * the bundle would be an opaque 1.3 MB blob nobody can regenerate.
 *
 *   Upstream : https://github.com/zai-org/ZCode  (public)
 *   Pinned   : UPSTREAM_COMMIT below
 *
 * Usage (from the repository root):
 *
 *   node build-vendor.mjs                 # download the pinned commit, rebuild
 *   node build-vendor.mjs --out X.js      # write somewhere else (for a dry run)
 *   ZCODE_SOURCE=<checkout> node build-vendor.mjs   # use a local checkout
 *
 * A local checkout must be at exactly UPSTREAM_COMMIT; a downloaded tarball is
 * pinned by the URL itself. No `git` binary is required either way.
 *
 * ── Why the output is post-processed ────────────────────────────────────────
 * The plugin's own code uses neutral names, but esbuild reproduces upstream's
 * `zcode`-flavoured identifiers verbatim. So after bundling we rewrite the
 * *names* while preserving every *data-format value* the wire requires — those
 * move into `lib/upstream-protocol.js` and are imported here. The result has no
 * `zcode` wording left except the literals in that one constants module.
 *
 * Upstream is Apache-2.0. This repository ships no licence files by choice; the
 * provenance above is the record of where the vendored code comes from.
 */
import { build } from 'esbuild';
import { resolve, join, dirname } from 'node:path';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';

const UPSTREAM_REPO = 'zai-org/ZCode';
const UPSTREAM_COMMIT = 'aac4755666d09fdcd70272fcf063c077a639015f';

const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const OUT = resolve(outIndex >= 0 ? args[outIndex + 1] : 'lib/wire.js');

/**
 * Extract only the directories we bundle, straight from the tar.gz.
 *
 * Windows' bundled bsdtar cannot create the upstream repo's non-ASCII doc paths
 * ("Invalid empty pathname"), and `--exclude` does not stop it from trying. A
 * ~40-line tar reader has no such limitation and removes the external `tar`
 * dependency entirely, which matters on a machine with no git and no GNU tar.
 */
async function extract(tarballPath, destDir) {
  const raw = gunzipSync(await readFile(tarballPath));
  const WANTED = ['packages/rpc/', 'packages/client/', 'packages/shared/', 'packages/model-option-map/'];
  let offset = 0;
  let root = null;
  let files = 0;
  while (offset + 512 <= raw.length) {
    const header = raw.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break; // end-of-archive marker
    const str = (from, len) => header.subarray(from, from + len).toString('utf8').replace(/\0.*$/, '');
    const name = str(0, 100);
    const prefix = str(345, 155);
    const sizeField = str(124, 12).trim();
    const size = sizeField ? parseInt(sizeField, 8) : 0;
    const type = String.fromCharCode(header[156] || 0x30);
    const full = prefix ? `${prefix}/${name}` : name;
    const body = raw.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (!full || full === './') continue;
    const slash = full.indexOf('/');
    if (slash < 0) continue;
    if (root === null) root = full.slice(0, slash);
    const rel = full.slice(slash + 1);
    if (!WANTED.some((w) => rel.startsWith(w))) continue;
    const target = join(destDir, root, rel);
    if (type === '5') { await mkdir(target, { recursive: true }); continue; }
    if (type !== '0' && type !== '') continue; // skip links/specials
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, body);
    files++;
  }
  if (!root) throw new Error('unexpected tarball layout');
  console.log(`extracted ${files} source files from the pinned tarball`);
  return join(destDir, root);
}

// ---------------------------------------------------------------- the source
async function sourceRoot() {
  if (process.env.ZCODE_SOURCE) {
    const ref = resolve(process.env.ZCODE_SOURCE);
    if (!existsSync(join(ref, 'packages/rpc/src/index.ts'))) throw new Error(`ZCODE_SOURCE has no packages/rpc/src/index.ts: ${ref}`);
    // A checkout can drift; a tarball cannot, because the commit is in the URL.
    try {
      const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ref, encoding: 'utf8' }).trim();
      if (sha !== UPSTREAM_COMMIT) throw new Error(`Expected ZCode ${UPSTREAM_COMMIT}, got ${sha}`);
    } catch (error) {
      if (String(error.message).startsWith('Expected')) throw error;
      console.warn(`note: could not verify the checkout with git (${error.code ?? 'no git'}); using ${ref} as-is`);
    }
    return ref;
  }
  const dir = join(tmpdir(), `zcode-${UPSTREAM_COMMIT.slice(0, 12)}`);
  const marker = join(dir, '.complete');
  if (existsSync(marker)) return join(dir, 'root');
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const url = `https://codeload.github.com/${UPSTREAM_REPO}/tar.gz/${UPSTREAM_COMMIT}`;
  const tarball = join(dir, 'src.tgz');
  console.log(`downloading ${UPSTREAM_REPO}@${UPSTREAM_COMMIT.slice(0, 12)} …`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`download failed: HTTP ${response.status} ${url}`);
  await writeFile(tarball, Buffer.from(await response.arrayBuffer()));
  const root = await extract(tarball, dir);
  await writeFile(marker, UPSTREAM_COMMIT);
  return root;
}

// ------------------------------------------------------------- the bundling
const ref = await sourceRoot();
const shared = resolve(ref, 'packages/shared/src');
await mkdir(dirname(OUT), { recursive: true });

const result = await build({
  stdin: {
    contents: `
      export { ChannelServer, ChannelClient, Emitter } from '${ref.replaceAll('\\', '/')}/packages/rpc/src/index.ts';
      export { createAcknowledgedWebRemoteControlRelayProtocol } from '${ref.replaceAll('\\', '/')}/packages/client/src/webRemoteControlAcknowledgedRelayProtocol.ts';
      export { encodeTopicWireFrames } from '${shared.replaceAll('\\', '/')}/zcode-protocol-v4/wire-codec.ts';
      export { conversationSnapshotSchema } from '${shared.replaceAll('\\', '/')}/zcode-protocol-v4/snapshot.ts';
      export { parseCommandEnvelope, commandAckSchema } from '${shared.replaceAll('\\', '/')}/zcode-protocol-v4/command.ts';
      export { appSettingsSchema } from '${shared.replaceAll('\\', '/')}/validationAppSettings.ts';
      export { conversationTopicFrameSchema, sessionsIndexTopicFrameSchema, workspaceConfigTopicFrameSchema, helloMessageSchema } from '${shared.replaceAll('\\', '/')}/zcode-protocol-v4/transport.ts';
      export { v4AttachmentBeginParamsSchema, v4AttachmentChunkParamsSchema, v4AttachmentCommitParamsSchema, v4AttachmentAbortParamsSchema, v4AttachmentReadParamsSchema } from '${shared.replaceAll('\\', '/')}/zcode-protocol-v4/transport.ts';
    `,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: OUT,
  metafile: true,
  legalComments: 'inline',
  plugins: [{
    name: 'reference-aliases',
    setup(b) {
      b.onResolve({ filter: /^@zcode\/rpc$/ }, () => ({ path: resolve(ref, 'packages/rpc/src/index.ts') }));
      b.onResolve({ filter: /^@zcode\/model-option-map$/ }, () => ({ path: resolve(ref, 'packages/model-option-map/src/index.ts') }));
      b.onResolve({ filter: /^@zcode\/shared$/ }, () => ({ path: 'shared-shim', namespace: 'shim' }));
      b.onLoad({ filter: /.*/, namespace: 'shim' }, () => ({
        contents: `export * from '${shared.replaceAll('\\', '/')}/web-remote-control-rpc-transport.ts';`,
        loader: 'ts',
        resolveDir: process.cwd(),
      }));
      b.onResolve({ filter: /^zod$/ }, () => ({ path: resolve('node_modules/zod/index.js') }));
    },
  }],
});

// ------------------------------------------------- the neutralising pass
// 1. Data-format values move to the constants module. Every literal that the
//    relay or the web client matches byte-for-byte is listed here; renaming one
//    silently breaks the link, which is why they are replaced *before* the
//    generic rename below.
const LITERALS = [
  ['"zcode-agent"', 'CHANNEL_AGENT'],
  ["'zcode-agent'", 'CHANNEL_AGENT'],
  ['"zcode-task"', 'CHANNEL_TASK'],
  ["'zcode-task'", 'CHANNEL_TASK'],
  ['"zcode-session"', 'CHANNEL_SESSION'],
  ["'zcode-session'", 'CHANNEL_SESSION'],
  ['"ZCode Protocol"', 'PROTOCOL_NAME'],
  ["'ZCode Protocol'", 'PROTOCOL_NAME'],
  ['"__zcode_rpc_nested_uint8array_v1"', 'RPC_NESTED_BINARY_MARKER'],
];
// 2. The same for *unquoted* keys: they are property names in upstream's data,
//    so they become computed keys rather than being renamed.
const KEYS = [
  [/\.zcode_type\b/g, '[FRAME_TYPE_KEY]'],
  [/([{,]\s*)zcode_type:/g, '$1[FRAME_TYPE_KEY]:'],
  [/\.zcodeEndpointOrigin\b/g, '[SETTINGS_ENDPOINT_ORIGIN_KEY]'],
  [/([{,]\s*)zcodeEndpointOrigin:/g, '$1[SETTINGS_ENDPOINT_ORIGIN_KEY]:'],
  [/"zcodeEndpointOrigin"/g, 'SETTINGS_ENDPOINT_ORIGIN_KEY'],
];
// 3. Prose that would otherwise read as branding after the rename.
const PROSE = [
  ['from the pinned ZCode commit', 'from the pinned upstream commit'],
  ['the ZCode client', 'the upstream client'],
  ['the official client', 'the upstream client'],
  ['ZCode endpoint origin', 'upstream endpoint origin'],
];
const PATHS = [
  [/\.\.\/\.\.\/previews\/zcode-reference\//g, 'upstream/'],
  [/previews\/zcode-reference\//g, 'upstream/'],
];

function neutralise(text) {
  let out = text;
  for (const [a, b] of LITERALS) out = out.split(a).join(b);
  for (const [re, b] of KEYS) out = out.replace(re, b);
  for (const [a, b] of PROSE) out = out.split(a).join(b);
  for (const [re, b] of PATHS) out = out.replace(re, b);
  // Case-preserving identifier rename: `zcodeWorkspaceRefSchema` -> `wireWorkspaceRefSchema`.
  out = out.replace(/zcode/gi, (m) => (m === 'ZCODE' ? 'WIRE' : m === 'zCode' ? 'wire' : m[0] === 'Z' ? 'Wire' : 'wire'));
  return out;
}

let text = await readFile(OUT, 'utf8');
text = neutralise(text);

// Only import the constants this build actually references.
const CONSTANTS = ['RELAY_ENDPOINT', 'WEB_CLIENT_ENDPOINT', 'CHANNEL_AGENT', 'CHANNEL_TASK',
  'CHANNEL_SESSION', 'FRAME_TYPE_KEY', 'PROTOCOL_NAME', 'RPC_NESTED_BINARY_MARKER',
  'SETTINGS_ENDPOINT_ORIGIN_KEY'];
const used = CONSTANTS.filter((name) => text.includes(name));
if (used.length) text = `import { ${used.join(', ')} } from './upstream-protocol.js';\n` + text;
await writeFile(OUT, text);

const leftover = (text.match(/zcode/gi) || []).length;
const inputs = Object.keys(result.metafile.inputs).filter((x) => !x.startsWith('node_modules'));
console.log(`built ${OUT}`);
console.log(`  upstream  : ${UPSTREAM_REPO}@${UPSTREAM_COMMIT}`);
console.log(`  inputs    : ${inputs.length} source files bundled`);
console.log(`  constants : ${used.join(', ') || '(none)'}`);
console.log(`  leftover  : ${leftover} 'zcode' occurrence(s) — must be 0`);
if (leftover) process.exitCode = 1;
