interface WheelManifest {
  pythonVersion: string;
  requirements: string[];
  files: string[];
}

/**
 * Absolute URLs for the wheels vendored by scripts/fetch_wheels.py. They are
 * served from the site itself rather than PyPI so a cold start is deterministic
 * and does not depend on PyPI's CORS behaviour.
 */
export async function vendoredWheelUrls(): Promise<string[]> {
  const base = new URL(`${import.meta.env.BASE_URL}wheels/`, location.href);
  const response = await fetch(new URL("wheels.json", base));
  if (!response.ok) {
    throw new Error(
      `could not load wheels.json (${response.status}) — run \`npm run wheels\``,
    );
  }
  const manifest = (await response.json()) as WheelManifest;
  return manifest.files.map((file) => new URL(file, base).href);
}
