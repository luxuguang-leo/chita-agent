/**
 * chita update tests (design cur-099): semver compare, asset naming,
 * release parsing, replace flow (offline: fetch is injected).
 */

import { test, expect } from "bun:test";
import { compareVersions, assetName, runUpdate, verifySha256 } from "./update.ts";
import { writeFileSync, mkdtempSync, writeFileSync as wfs, chmodSync, readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

/* ------------------------- semver compare ------------------------- */
test("compareVersions: major/minor/patch ordering", () => {
  expect(compareVersions("0.1.0", "0.1.0")).toBe(0);
  expect(compareVersions("0.2.0", "0.1.9")).toBe(1);
  expect(compareVersions("1.0.0", "0.9.9")).toBe(1);
  expect(compareVersions("0.1.0", "0.2.0")).toBe(-1);
});

test("compareVersions: v prefix and missing parts", () => {
  expect(compareVersions("v0.1.0", "0.1.0")).toBe(0);
  expect(compareVersions("0.1", "0.1.0")).toBe(0);
  expect(compareVersions("0.1.0", "0.1")).toBe(0);
});

test("compareVersions: pre-release suffixes ignored", () => {
  expect(compareVersions("0.2.0-rc.1", "0.2.0")).toBe(0);
  expect(compareVersions("0.1.0-beta", "0.2.0")).toBe(-1);
});

test("compareVersions: garbage input treated as 0 (no crash)", () => {
  expect(compareVersions("abc", "0.1.0")).toBe(-1);
  expect(compareVersions("0.1.0", "xyz")).toBe(1);
});

/* ------------------------- asset naming ------------------------- */
test("assetName: darwin/linux arm64+x64, windows x64 exe", () => {
  expect(assetName("darwin", "arm64")).toBe("chita-darwin-arm64");
  expect(assetName("darwin", "x64")).toBe("chita-darwin-x64");
  expect(assetName("linux", "arm64")).toBe("chita-linux-arm64");
  expect(assetName("linux", "x64")).toBe("chita-linux-x64");
  expect(assetName("win32", "x64")).toBe("chita-windows-x64.exe");
});

test("assetName: unknown platform/arch throws", () => {
  expect(() => assetName("win32", "arm64")).toThrow(/unsupported/);
  expect(() => assetName("freebsd", "x64")).toThrow(/unsupported/);
  expect(() => assetName("darwin", "ia32")).toThrow(/unsupported/);
});

/* ------------------------- update flow ------------------------- */
test("up-to-date: latest <= current → no download, status up-to-date", async () => {
  const calls: string[] = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    calls.push("fetch");
    return new Response(
      JSON.stringify({ tag_name: "v0.1.0", assets: [{ name: assetName(), browser_download_url: "https://x/a" }] }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }) as unknown as typeof fetch;
  try {
    const r = await runUpdate({ currentVersion: "0.1.0" });
    expect(r.status).toBe("up-to-date");
    expect(r.message).toContain("already up to date");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("check-only: newer release → reports available, does not download", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({ tag_name: "v0.2.0", assets: [{ name: assetName(), browser_download_url: "https://x/a" }] }),
      { status: 200 }
    )) as unknown as typeof fetch;
  try {
    const r = await runUpdate({ currentVersion: "0.1.0", checkOnly: true });
    expect(r.status).toBe("check-only");
    expect(r.message).toContain("update available");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("update: downloads asset, writes tmp 0600, renames onto realpath, symlink intact", async () => {
  // fixture: real file + symlink to it (like ~/.local/bin/chita -> dist/chita)
  const dir = mkdtempSync(join(tmpdir(), "chita-update-"));
  const real = join(dir, "chita");
  writeFileSync(real, "old-binary", { mode: 0o755 });
  const link = join(dir, "chita-link");
  const { symlinkSync } = await import("node:fs");
  symlinkSync(real, link);

  const downloads: string[] = [];
  const origFetch = globalThis.fetch;
  let body = "new-binary-content";
  globalThis.fetch = (async (url: string) => {
    if (typeof url === "string" && url.includes("releases/latest")) {
      return new Response(
        JSON.stringify({
          tag_name: "v0.2.0",
          assets: [{ name: assetName(), browser_download_url: "https://x/bin" }],
        }),
        { status: 200 }
      );
    }
    downloads.push(String(url));
    return new Response(body, { status: 200 });
  }) as unknown as typeof fetch;
  try {
    const r = await runUpdate({ currentVersion: "0.1.0", execPath: link });
    expect(r.status).toBe("updated");
    expect(r.message).toContain("0.1.0 -> 0.2.0");
    // the REAL file was replaced (target of the symlink), link intact
    expect(readFileSync(real, "utf-8")).toBe("new-binary-content");
    expect(readFileSync(link, "utf-8")).toBe("new-binary-content"); // follows symlink
    // link is still a symlink, not a regular file
    const { lstatSync } = await import("node:fs");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    // no tmp left behind
    const leftovers = (await import("node:fs")).readdirSync(dir).filter((f) => f.includes(".tmp"));
    expect(leftovers).toEqual([]);
    expect(downloads.length).toBe(1);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("update: missing asset for platform → error, nothing written", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chita-update-"));
  const real = join(dir, "chita");
  writeFileSync(real, "old", { mode: 0o755 });
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({ tag_name: "v0.2.0", assets: [{ name: "chita-not-a-platform", browser_download_url: "https://x/l" }] }),
      { status: 200 }
    )) as unknown as typeof fetch;
  try {
    await expect(runUpdate({ currentVersion: "0.1.0", execPath: real })).rejects.toThrow(/no release asset/);
    expect(readFileSync(real, "utf-8")).toBe("old");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("update: API failure → error (exit 1 path)", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("rate limited", { status: 403 })) as unknown as typeof fetch;
  try {
    await expect(runUpdate({ currentVersion: "0.1.0" })).rejects.toThrow(/403/);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("update: download failure → error, original file intact", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chita-update-"));
  const real = join(dir, "chita");
  writeFileSync(real, "old", { mode: 0o755 });
  const origFetch = globalThis.fetch;
  let phase = "meta";
  globalThis.fetch = (async () => {
    if (phase === "meta") {
      phase = "bin";
      return new Response(
        JSON.stringify({ tag_name: "v0.2.0", assets: [{ name: assetName(), browser_download_url: "https://x/b" }] }),
        { status: 200 }
      );
    }
    return new Response("boom", { status: 500 });
  }) as unknown as unknown as typeof fetch;
  try {
    await expect(runUpdate({ currentVersion: "0.1.0", execPath: real })).rejects.toThrow(/download failed/);
    expect(readFileSync(real, "utf-8")).toBe("old");
  } finally {
    globalThis.fetch = origFetch;
  }
});

/* ------------------------- sha256 verify ------------------------- */
test("verifySha256: matching checksum passes, mismatch fails", () => {
  const dir = mkdtempSync(join(tmpdir(), "chita-update-"));
  const sums = join(dir, "SHA256SUMS");
  const content = new TextEncoder().encode("hello");
  const hash = createHash("sha256").update("hello").digest("hex");
  wfs(sums, `${hash}  chita-darwin-arm64\n`);
  expect(verifySha256(sums, "chita-darwin-arm64", content)).toBe(true);
  wfs(sums, `${"0".repeat(64)}  chita-darwin-arm64\n`);
  expect(verifySha256(sums, "chita-darwin-arm64", content)).toBe(false);
});

test("update: SHA256SUMS present → integrity verified before replace", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chita-update-"));
  const real = join(dir, "chita");
  writeFileSync(real, "old", { mode: 0o755 });
  const body = "new-binary";
  const hash = createHash("sha256").update(body).digest("hex");
  const origFetch = globalThis.fetch;
  let downloads = 0;
  globalThis.fetch = (async (url: unknown) => {
    const u = String(url);
    if (u.includes("releases/latest")) {
      return new Response(
        JSON.stringify({
          tag_name: "v0.2.0",
          assets: [
            { name: assetName(), browser_download_url: "https://x/bin" },
            { name: "SHA256SUMS", browser_download_url: "https://x/sums" },
          ],
        }),
        { status: 200 }
      );
    }
    downloads++;
    if (u.includes("/sums")) return new Response(`${hash}  ${assetName()}\n`, { status: 200 });
    return new Response(body, { status: 200 });
  }) as unknown as typeof fetch;
  try {
    const r = await runUpdate({ currentVersion: "0.1.0", execPath: real });
    expect(r.status).toBe("updated");
    expect(readFileSync(real, "utf-8")).toBe("new-binary");
    expect(downloads).toBe(2); // binary + SHA256SUMS
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("update: checksum mismatch → abort, original intact", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chita-update-"));
  const real = join(dir, "chita");
  writeFileSync(real, "old", { mode: 0o755 });
  const origFetch = globalThis.fetch;
  let downloads = 0;
  globalThis.fetch = (async (url: unknown) => {
    const u = String(url);
    if (u.includes("releases/latest")) {
      return new Response(
        JSON.stringify({
          tag_name: "v0.2.0",
          assets: [
            { name: assetName(), browser_download_url: "https://x/bin" },
            { name: "SHA256SUMS", browser_download_url: "https://x/sums" },
          ],
        }),
        { status: 200 }
      );
    }
    downloads++;
    if (u.includes("/sums")) return new Response(`${"0".repeat(64)}  ${assetName()}\n`, { status: 200 });
    return new Response("tampered", { status: 200 });
  }) as unknown as typeof fetch;
  try {
    await expect(runUpdate({ currentVersion: "0.1.0", execPath: real })).rejects.toThrow(/integrity check failed/);
    expect(readFileSync(real, "utf-8")).toBe("old"); // never replaced
    expect(downloads).toBe(2);
  } finally {
    globalThis.fetch = origFetch;
  }
});
