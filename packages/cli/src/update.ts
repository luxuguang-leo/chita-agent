/**
 * chita self-update (v2.1 §8 update; design reviewed cur-099)
 *
 * Data source: GitHub Releases (latest). Asset naming: chita-<os>-<arch>[.exe]
 * (NO version in the filename — the version lives in the release tag; we only
 * match assets[].name from the API, never parse URLs).
 *
 * Replace strategy (cur-099 F3): realpath(execPath) is the target — the
 * ~/.local/bin/chita symlink must NOT be touched (rename over it would turn
 * the link into a regular file). Write `.<name>.<pid>.tmp` (0600) in the
 * same dir, then rename onto the realpath. macOS/Linux allow replacing a
 * running inode; Windows locks the file → refuse self-upgrade there.
 */

import { realpathSync, writeFileSync, renameSync, unlinkSync, chmodSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, basename, dirname } from "node:path";

export const UPDATE_REPO = "luxuguang-leo/chita-agent";
const GITHUB_API = "https://api.github.com";

export interface UpdateAsset {
  name: string;
  browser_download_url: string;
}

export interface LatestRelease {
  tag_name: string;
  assets: UpdateAsset[];
}

/** Asset name for the current platform (cur-099 F2/F7). */
export function assetName(platform = process.platform, arch = process.arch): string {
  switch (platform) {
    case "darwin":
      if (arch === "arm64" || arch === "x64") return `chita-darwin-${arch}`;
      break;
    case "linux":
      if (arch === "arm64" || arch === "x64") return `chita-linux-${arch}`;
      break;
    case "win32":
      if (arch === "x64") return "chita-windows-x64.exe";
      break;
  }
  throw new Error(`unsupported platform/arch: ${platform}/${arch}`);
}

/** Minimal semver compare (x.y.z, ignores pre-release suffixes). No deps. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): number[] => {
    const parts = v
      .replace(/^v/, "")
      .split(/[.-]/)
      .slice(0, 3)
      .map((n) => parseInt(n, 10) || 0);
    while (parts.length < 3) parts.push(0); // "0.1" == "0.1.0"
    return parts;
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

/** GitHub API headers: UA + optional token (reduces 403, cur-100 F5). */
function apiHeaders(): Record<string, string> {
  const h: Record<string, string> = { "User-Agent": "chita-update", Accept: "application/vnd.github+json" };
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

/** Fetch the latest release from GitHub. Throws on API/network errors. */
export async function fetchLatestRelease(repo = UPDATE_REPO): Promise<LatestRelease> {
  const res = await fetch(`${GITHUB_API}/repos/${repo}/releases/latest`, { headers: apiHeaders() });
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status}: ${res.statusText}`);
  }
  const data = (await res.json()) as { tag_name: string; assets: { name: string; browser_download_url: string }[] };
  return { tag_name: data.tag_name, assets: data.assets };
}

export interface UpdateResult {
  status: "up-to-date" | "updated" | "check-only" | "error";
  current: string;
  latest: string;
  message: string;
}

/**
 * Core update flow. `checkOnly` skips download/replace.
 * Throws on any failure (caller maps to exit code 1).
 */
export async function runUpdate(opts: {
  currentVersion: string;
  checkOnly?: boolean;
  repo?: string;
  execPath?: string; // default process.execPath
}): Promise<UpdateResult> {
  const { currentVersion, checkOnly } = opts;
  const repo = opts.repo ?? UPDATE_REPO;
  const execPath = opts.execPath ?? process.execPath;

  const release = await fetchLatestRelease(repo);
  const latest = release.tag_name.replace(/^v/, "");
  const cmp = compareVersions(latest, currentVersion);

  if (cmp <= 0) {
    return { status: "up-to-date", current: currentVersion, latest, message: `already up to date (${currentVersion})` };
  }
  if (checkOnly) {
    return {
      status: "check-only",
      current: currentVersion,
      latest,
      message: `update available: ${currentVersion} -> ${latest} (run \`chita update\` to upgrade)`,
    };
  }
  if (!canSelfUpdate()) {
    throw new Error(
      `self-update is not supported on Windows (running file is locked). ` +
        `Download ${assetName()} from ${repo} releases manually.`
    );
  }

  // find the asset for THIS platform (exact name match, never URL parsing)
  const want = assetName();
  const asset = release.assets.find((a) => a.name === want);
  if (!asset) {
    throw new Error(`no release asset for this platform (${want}) in ${repo}@${latest}`);
  }

  const real = realpathSync(execPath); // resolve the symlink; replace THIS file
  const dir = dirname(real);
  const tmp = join(dir, `.${basename(real)}.${process.pid}.tmp`);

  // download the binary, then the SHA256SUMS if the release ships one
  const bin = await download(asset.browser_download_url, asset.name);
  const sumsAsset = release.assets.find((a) => a.name === "SHA256SUMS");
  if (sumsAsset) {
    const checksums = await download(sumsAsset.browser_download_url, sumsAsset.name);
    const tmpSums = `${tmp}.sha256`;
    writeFileSync(tmpSums, checksums, { mode: 0o600 });
    if (!verifySha256(tmpSums, asset.name, bin)) {
      try {
        unlinkSync(tmpSums);
      } catch {
        /* best-effort */
      }
      throw new Error(`integrity check failed: ${asset.name} does not match SHA256SUMS (aborting — nothing was written)`);
    }
    try {
      unlinkSync(tmpSums);
    } catch {
      /* best-effort */
    }
  }

  // write tmp 0600, then atomic rename onto the realpath (cur-099 F3).
  // On rename failure the tmp is KEPT for inspection (cur-100 F3) — do not
  // unlink it; the user can diff/retry manually.
  writeFileSync(tmp, bin, { mode: 0o600 });
  chmodSync(tmp, 0o755);
  try {
    renameSync(tmp, real);
  } catch (e) {
    throw new Error(`replace failed: ${String(e)} (partial download kept at ${tmp})`);
  }

  return { status: "updated", current: currentVersion, latest, message: `updated ${currentVersion} -> ${latest}` };
}

/** Download a release asset into memory. Throws on HTTP/empty.
 *  Deliberately UA-only (no Authorization): browser_download_url 302s to
 *  objects.githubusercontent.com, where a Bearer header triggers GitHub's
 *  auth-redirect handling — UA alone is more stable (cur-101 nit). */
async function download(url: string, name: string): Promise<Uint8Array> {
  const res = await fetch(url, { headers: { "User-Agent": "chita-update" } });
  if (!res.ok) {
    throw new Error(`download failed: HTTP ${res.status} (${name})`);
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.length === 0) {
    throw new Error(`download empty: ${name}`);
  }
  return buf;
}

/** Windows self-upgrade: refuse (file is locked while running). */
export function canSelfUpdate(platform = process.platform): boolean {
  return platform !== "win32";
}

/** Verify downloaded bytes against a SHA256SUMS file (cur-099 F5, cur-100 F2). */
export function verifySha256(file: string, assetName_: string, content: Uint8Array): boolean {
  const want = readFileSync(file, "utf-8")
    .split("\n")
    .find((l) => l.trim().endsWith(`  ${assetName_}`) || l.trim().endsWith(` ${assetName_}`));
  if (!want) return false;
  const expected = want.trim().split(/\s+/)[0];
  const actual = createHash("sha256").update(content).digest("hex");
  return actual === expected;
}
