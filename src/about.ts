import manifest from "../package.json" with { type: "json" };

// Project identity survives a fresh Git checkout. Change repository.url when moving the project.
const repository = new URL(manifest.repository.url);
const [owner, repo] = repository.pathname.split("/").filter(Boolean);
export const ABOUT_PROJECT = {
  name: manifest.name, version: manifest.version, author: manifest.author.name,
  owner, repo, url: `https://github.com/${owner}/${repo}`,
  authorUrl: manifest.author.url, license: manifest.license,
};

export interface GithubAbout {
  author: string; description: string | null; stars: number | null;
  license: string | null; latestVersion: string | null;
  repositoryAvailable: boolean; authorAvailable: boolean; releaseAvailable: boolean;
}

export async function fetchGithubAbout(fetcher: typeof fetch = fetch): Promise<GithubAbout> {
  const read = async (path: string) => {
    try {
      const response = await fetcher(`https://api.github.com/${path}`, {
        headers: { Accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) return { ok: false, status: response.status, data: null };
      return { ok: true, status: response.status, data: await response.json() };
    } catch { return { ok: false, status: 0, data: null }; }
  };
  const [project, author, release] = await Promise.all([
    read(`repos/${owner}/${repo}`), read(`users/${owner}`), read(`repos/${owner}/${repo}/releases/latest`),
  ]);
  const text = (value: unknown) => typeof value === "string" && value.trim() ? value.trim().slice(0, 500) : null;
  const license = text(project.data?.license?.spdx_id);
  return {
    author: text(author.data?.name) ?? text(author.data?.login) ?? manifest.author.name,
    description: text(project.data?.description),
    stars: Number.isSafeInteger(project.data?.stargazers_count) && project.data.stargazers_count >= 0 ? project.data.stargazers_count : null,
    license: license === "NOASSERTION" ? null : license,
    latestVersion: text(release.data?.tag_name),
    repositoryAvailable: project.ok, authorAvailable: author.ok,
    releaseAvailable: release.ok || (project.ok && release.status === 404),
  };
}

let cached: { fetchedAt: number; value: Promise<GithubAbout> } | undefined;
export function loadGithubAbout(refresh = false): Promise<GithubAbout> {
  if (!cached || refresh || Date.now() - cached.fetchedAt > 10 * 60 * 1000) {
    cached = { fetchedAt: Date.now(), value: fetchGithubAbout() };
  }
  return cached.value;
}
