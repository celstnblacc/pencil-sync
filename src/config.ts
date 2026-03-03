import { readFile, access } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import type {
  PencilSyncConfig,
  MappingConfig,
  Framework,
  Styling,
  Settings,
} from "./types.js";
import { DEFAULT_SETTINGS } from "./types.js";
import { log } from "./logger.js";

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function safeMerge<T>(base: T, overrides?: Partial<T>): T {
  const result = { ...base };
  if (overrides) {
    for (const key of Object.keys(overrides) as (keyof T)[]) {
      if (!DANGEROUS_KEYS.has(key as string)) {
        result[key] = overrides[key] as T[keyof T];
      }
    }
  }
  return result;
}

const CONFIG_FILENAMES = [
  "pencil-sync.config.json",
  ".pencil-sync.json",
  "pencil-sync.config.jsonc",
];

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function detectFramework(
  projectDir: string,
): Promise<Framework> {
  const checks: [string, Framework][] = [
    ["next.config.js", "nextjs"],
    ["next.config.mjs", "nextjs"],
    ["next.config.ts", "nextjs"],
    ["svelte.config.js", "svelte"],
    ["astro.config.mjs", "astro"],
    ["vue.config.js", "vue"],
    ["vite.config.ts", "react"],
    ["vite.config.js", "react"],
  ];

  for (const [file, framework] of checks) {
    if (await fileExists(join(projectDir, file))) {
      return framework;
    }
  }

  const pkgPath = join(projectDir, "package.json");
  if (await fileExists(pkgPath)) {
    try {
      const pkg = JSON.parse(await readFile(pkgPath, "utf-8"));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps["next"]) return "nextjs";
      if (deps["svelte"]) return "svelte";
      if (deps["astro"]) return "astro";
      if (deps["vue"]) return "vue";
      if (deps["react"]) return "react";
    } catch {
      // ignore parse errors
    }
  }

  return "unknown";
}

export async function detectStyling(projectDir: string): Promise<Styling> {
  const tailwindIndicators = [
    "tailwind.config.js",
    "tailwind.config.ts",
    "tailwind.config.mjs",
    "postcss.config.js",
    "postcss.config.mjs",
    "postcss.config.ts",
  ];
  for (const file of tailwindIndicators) {
    if (await fileExists(join(projectDir, file))) {
      return "tailwind";
    }
  }

  const pkgPath = join(projectDir, "package.json");
  if (await fileExists(pkgPath)) {
    try {
      const pkg = JSON.parse(await readFile(pkgPath, "utf-8"));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps["tailwindcss"]) return "tailwind";
      if (deps["styled-components"]) return "styled-components";
    } catch {
      // ignore
    }
  }

  return "unknown";
}

async function findProjectRoot(codeDir: string, configDir: string): Promise<string> {
  // Check codeDir first, then walk up to configDir looking for package.json
  const dirs = [codeDir];
  let current = dirname(codeDir);
  // Walk up but not past the config directory's parent
  const stopAt = dirname(configDir);
  while (current.length >= stopAt.length && current !== dirs[dirs.length - 1]) {
    dirs.push(current);
    current = dirname(current);
  }

  for (const dir of dirs) {
    if (await fileExists(join(dir, "package.json"))) {
      return dir;
    }
  }
  return codeDir;
}

async function resolveMapping(
  mapping: MappingConfig,
  configDir: string,
): Promise<MappingConfig> {
  const resolved = { ...mapping };
  resolved.penFile = resolve(configDir, mapping.penFile);
  resolved.codeDir = resolve(configDir, mapping.codeDir);

  const projectRoot = await findProjectRoot(resolved.codeDir, configDir);

  if (!resolved.framework) {
    resolved.framework = await detectFramework(projectRoot);
    log.debug(`Auto-detected framework: ${resolved.framework} for ${resolved.id}`);
  }
  if (!resolved.styling) {
    resolved.styling = await detectStyling(projectRoot);
    log.debug(`Auto-detected styling: ${resolved.styling} for ${resolved.id}`);
  }

  return resolved;
}

export async function loadConfig(
  configPath?: string,
): Promise<PencilSyncConfig> {
  let resolvedPath: string | undefined;

  if (configPath) {
    resolvedPath = resolve(configPath);
  } else {
    const cwd = process.cwd();
    for (const name of CONFIG_FILENAMES) {
      const candidate = join(cwd, name);
      if (await fileExists(candidate)) {
        resolvedPath = candidate;
        break;
      }
    }
  }

  if (!resolvedPath) {
    throw new Error(
      `No config file found. Create pencil-sync.config.json or pass --config.`,
    );
  }

  log.debug(`Loading config from ${resolvedPath}`);

  const raw = await readFile(resolvedPath, "utf-8");
  // Strip JSONC comments
  const cleaned = raw.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const parsed = JSON.parse(cleaned) as Partial<PencilSyncConfig>;

  if (!parsed.mappings || parsed.mappings.length === 0) {
    throw new Error("Config must have at least one mapping.");
  }

  const configDir = dirname(resolvedPath);
  const settings: Settings = safeMerge(DEFAULT_SETTINGS, parsed.settings);

  // Resolve state file path relative to config
  settings.stateFile = resolve(configDir, settings.stateFile);

  const mappings = await Promise.all(
    parsed.mappings.map((m) => resolveMapping(m as MappingConfig, configDir)),
  );

  return {
    version: parsed.version ?? 1,
    mappings,
    settings,
  };
}
