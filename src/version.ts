import packageJson from '../package.json' with { type: 'json' };

export interface BuildVersionInfo {
  version: string;
  commit: string;
  buildTime: string | null;
}

/**
 * Returns non-secret build metadata for the running process.
 * Reads git commit and build timestamp from environment variables / Docker build args.
 */
export function getBuildVersionInfo(env: NodeJS.ProcessEnv = process.env): BuildVersionInfo {
  const commit = (env.GIT_COMMIT ?? env.RENDER_GIT_COMMIT ?? 'unknown').trim() || 'unknown';
  const buildTime = (env.BUILD_TIME ?? '').trim() || null;
  return {
    version: packageJson.version,
    commit,
    buildTime,
  };
}
