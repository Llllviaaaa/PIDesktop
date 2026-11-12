/**
 * Package boundaries of the Harness (ADR 0003, ADR 0005), checked against the
 * real import graph of packages/* rather than left to review.
 *
 * - Contract packages (vocabulary, service interfaces, shared RPC/UI
 *   contracts) import only other contract packages.
 * - Implementation and feature packages import contract packages. Importing
 *   another implementation is a horizontal coupling and must be listed in
 *   IMPLEMENTATION_EDGES together with the reason it exists.
 * - Only @qianji/host (the cordis root) loads @qianji/agent-loop, and no
 *   runtime code imports @qianji/testkit.
 * - Every @qianji/* that a package's src/ imports is declared in its
 *   dependencies.
 * - Relative imports in src/ stay inside the package, and nothing under
 *   packages/ reaches the renderer (src/) or the desktop shell (src-tauri/)
 *   by path.
 * - The package graph has no cycles.
 *
 * The rules cover src/ (the code the host bundles); test/ may wire several
 * packages together. Imports are read with ts.preProcessFile, which sees
 * import, export-from, import() and bare `import "x"`, but not specifiers
 * quoted inside strings (the scaffold templates in host/src/plugin-dev-tools.ts
 * contain `@qianji/client` imports as text).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "..");
const PACKAGES_DIR = join(REPO_ROOT, "packages");
const SCOPE = "@qianji/";

/** Vocabulary and service interfaces (ADR 0003 "接口包") plus shared contracts. */
const CONTRACT_PACKAGES = new Set([
  "agent",
  "commands",
  "kernel",
  "llm",
  "protocol",
  "rpc",
  "session",
  "system-prompt",
  "tools",
  "ui",
]);

/** The cordis root: it mounts every plugin, so it may import anything. */
const COMPOSITION_ROOT = "host";

/** Test helpers: built on contracts, imported only from test/. */
const TEST_ONLY_PACKAGES = new Set(["testkit"]);

/** Loaded by the composition root only (ADR 0005). */
const LOOP_PACKAGE = "agent-loop";

/**
 * Implementation → implementation imports that are allowed, keyed
 * "<from> -> <to>", each with the reason it exists. Keep this list short: an
 * entry means one feature depends on another feature's concrete behaviour.
 */
const IMPLEMENTATION_EDGES: Record<string, string> = {
  "memory -> permissions": "the memory tool denies or confirms writes by the session's effective permission mode",
  "session-search-fts -> session-jsonl": "the FTS index parses and walks the JSONL session files it indexes",
};

type Kind = "contract" | "root" | "test-only" | "implementation";

function kindOf(pkg: string): Kind {
  if (CONTRACT_PACKAGES.has(pkg)) return "contract";
  if (pkg === COMPOSITION_ROOT) return "root";
  if (TEST_ONLY_PACKAGES.has(pkg)) return "test-only";
  return "implementation";
}

interface ImportRef {
  /** Repo-relative path of the importing file, with forward slashes. */
  file: string;
  absoluteFile: string;
  specifier: string;
}

interface PackageInfo {
  /** Directory name under packages/, e.g. "agent-loop". */
  dir: string;
  root: string;
  name: string;
  runtimeDependencies: Set<string>;
  srcImports: ImportRef[];
  testImports: ImportRef[];
}

const SOURCE_FILE = /\.[cm]?[jt]sx?$/;

function toRepoPath(path: string): string {
  return relative(REPO_ROOT, path).split(sep).join("/");
}

function isInside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") files.push(...sourceFiles(path));
    } else if (SOURCE_FILE.test(entry.name)) {
      files.push(path);
    }
  }
  return files;
}

function importsOf(dir: string): ImportRef[] {
  return sourceFiles(dir).flatMap((absoluteFile) =>
    ts
      .preProcessFile(readFileSync(absoluteFile, "utf8"), true, true)
      .importedFiles.map((ref) => ({ file: toRepoPath(absoluteFile), absoluteFile, specifier: ref.fileName })),
  );
}

/** The workspace package a `@qianji/*` specifier names, or undefined for anything else. */
function scopedTarget(specifier: string): string | undefined {
  if (!specifier.startsWith(SCOPE)) return undefined;
  return specifier.slice(SCOPE.length).split("/")[0];
}

function loadPackages(): PackageInfo[] {
  return readdirSync(PACKAGES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(PACKAGES_DIR, entry.name, "package.json")))
    .map((entry) => {
      const root = join(PACKAGES_DIR, entry.name);
      const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
        name?: string;
        dependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
      };
      return {
        dir: entry.name,
        root,
        name: manifest.name ?? "",
        runtimeDependencies: new Set(Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies })),
        srcImports: importsOf(join(root, "src")),
        testImports: importsOf(join(root, "test")),
      };
    })
    .sort((a, b) => a.dir.localeCompare(b.dir));
}

const PACKAGES = loadPackages();
const PACKAGE_DIRS = new Set(PACKAGES.map((pkg) => pkg.dir));

/** Distinct workspace packages each package's src/ imports, with one importing file per edge. */
function srcEdges(pkg: PackageInfo): Map<string, string> {
  const edges = new Map<string, string>();
  for (const ref of pkg.srcImports) {
    const target = scopedTarget(ref.specifier);
    if (target === undefined || target === pkg.dir || edges.has(target)) continue;
    edges.set(target, ref.file);
  }
  return edges;
}

describe("Harness package boundaries (ADR 0003, ADR 0005)", () => {
  it("finds the packages and names each one @qianji/<directory>", () => {
    expect(PACKAGES.length).toBeGreaterThan(10);
    expect(PACKAGE_DIRS.has(COMPOSITION_ROOT)).toBe(true);
    expect(PACKAGE_DIRS.has(LOOP_PACKAGE)).toBe(true);
    for (const contract of CONTRACT_PACKAGES) expect(PACKAGE_DIRS.has(contract), `contract package ${contract}`).toBe(true);
    const misnamed = PACKAGES.filter((pkg) => pkg.name !== SCOPE + pkg.dir).map((pkg) => `packages/${pkg.dir} is named "${pkg.name}"`);
    expect(misnamed).toEqual([]);
  });

  it("keeps contract packages free of implementation imports", () => {
    const violations: string[] = [];
    for (const pkg of PACKAGES.filter((candidate) => kindOf(candidate.dir) === "contract")) {
      for (const [target, file] of srcEdges(pkg)) {
        if (kindOf(target) !== "contract") violations.push(`${file}: contract ${pkg.dir} imports ${kindOf(target)} ${SCOPE}${target}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("lets implementations import only contracts, plus the listed horizontal edges", () => {
    const violations: string[] = [];
    for (const pkg of PACKAGES.filter((candidate) => ["implementation", "test-only"].includes(kindOf(candidate.dir)))) {
      for (const [target, file] of srcEdges(pkg)) {
        if (kindOf(target) === "contract") continue;
        if (kindOf(pkg.dir) === "implementation" && `${pkg.dir} -> ${target}` in IMPLEMENTATION_EDGES) continue;
        violations.push(`${file}: ${pkg.dir} imports ${kindOf(target)} ${SCOPE}${target}; depend on a contract package or add the edge to IMPLEMENTATION_EDGES with its reason`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("lists only horizontal edges that still exist", () => {
    const stale = Object.keys(IMPLEMENTATION_EDGES).filter((edge) => {
      const [from, to] = edge.split(" -> ");
      const pkg = PACKAGES.find((candidate) => candidate.dir === from);
      return pkg === undefined || to === undefined || !srcEdges(pkg).has(to) || kindOf(from) !== "implementation" || kindOf(to) !== "implementation";
    });
    expect(stale).toEqual([]);
  });

  it("loads @qianji/agent-loop only from @qianji/host, and @qianji/testkit only from tests", () => {
    const violations: string[] = [];
    for (const pkg of PACKAGES) {
      const edges = srcEdges(pkg);
      const loopFile = edges.get(LOOP_PACKAGE);
      if (loopFile !== undefined && pkg.dir !== COMPOSITION_ROOT) violations.push(`${loopFile}: only ${SCOPE}${COMPOSITION_ROOT} mounts ${SCOPE}${LOOP_PACKAGE}`);
      for (const testOnly of TEST_ONLY_PACKAGES) {
        const file = edges.get(testOnly);
        if (file !== undefined) violations.push(`${file}: ${SCOPE}${testOnly} is for test/ only`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("declares every @qianji/* import of src/ in dependencies", () => {
    const violations: string[] = [];
    for (const pkg of PACKAGES) {
      for (const [target, file] of srcEdges(pkg)) {
        if (!PACKAGE_DIRS.has(target)) violations.push(`${file}: ${SCOPE}${target} is not a workspace package`);
        else if (!pkg.runtimeDependencies.has(SCOPE + target)) violations.push(`packages/${pkg.dir}/package.json: missing "${SCOPE}${target}" (imported by ${file})`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("keeps relative imports inside the package, and never reaches src/ or src-tauri/", () => {
    const renderer = join(REPO_ROOT, "src");
    const shell = join(REPO_ROOT, "src-tauri");
    const violations: string[] = [];
    for (const pkg of PACKAGES) {
      const check = (ref: ImportRef, fromSrc: boolean): void => {
        if (!ref.specifier.startsWith(".")) return;
        const target = resolve(dirname(ref.absoluteFile), ref.specifier);
        if (isInside(target, renderer) || isInside(target, shell)) violations.push(`${ref.file}: imports ${toRepoPath(target)} by path`);
        else if (fromSrc && !isInside(target, pkg.root)) violations.push(`${ref.file}: leaves packages/${pkg.dir} via "${ref.specifier}"; import the package by name`);
      };
      for (const ref of pkg.srcImports) check(ref, true);
      for (const ref of pkg.testImports) check(ref, false);
    }
    expect(violations).toEqual([]);
  });

  it("has no cycles between packages", () => {
    const graph = new Map(PACKAGES.map((pkg) => [pkg.dir, [...srcEdges(pkg).keys()].filter((target) => PACKAGE_DIRS.has(target))]));
    const state = new Map<string, "visiting" | "done">();
    const cycles: string[] = [];
    const visit = (node: string, path: string[]): void => {
      if (state.get(node) === "done") return;
      if (state.get(node) === "visiting") {
        cycles.push([...path.slice(path.indexOf(node)), node].join(" -> "));
        return;
      }
      state.set(node, "visiting");
      for (const next of graph.get(node) ?? []) visit(next, [...path, node]);
      state.set(node, "done");
    };
    for (const node of graph.keys()) visit(node, []);
    expect(cycles).toEqual([]);
  });
});
