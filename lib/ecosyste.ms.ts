import axios from 'axios';

import { readJsonCache, writeJsonCache } from './cache.ts';
import { error } from './log.ts';
import { sleep } from './utils.ts';

export const ECOSYSTEMS_API_URL = 'https://packages.ecosyste.ms/api/v1';
export const ECOSYSTEMS_REPOS_API_URL = 'https://repos.ecosyste.ms/api/v1';
export const ECOSYSTEMS_COMMITS_API_URL = 'https://commits.ecosyste.ms/api/v1';
export const ECOSYSTEMS_ISSUES_API_URL = 'https://issues.ecosyste.ms/api/v1';
export const ECOSYSTEMS_MAILTO = 'leo@oficonsortium.org';
export const ECOSYSTEMS_BATCH_SIZE = 100;
export const ECOSYSTEMS_LOOKUP_DELAY_MS = 100;

export type RepoMetadata = {
  full_name?: string;
  owner?: string | null;
  host?: { name?: string | null } | null;
  description: string | null;
  stargazers_count?: number;
  forks_count?: number;
  open_issues_count?: number;
  pushed_at?: string;
  created_at?: string;
  license: string | null;
  topics?: string[] | null;
  archived?: boolean;
  fork?: boolean;
  commit_stats?: { total_commits: number; total_committers: number; last_synced_commit?: string | null };
};

export type EcosystemsPackage = {
  name: string;
  ecosystem: string;
  description: string | null;
  repository_url: string | null;
  downloads: number;
  dependent_packages_count: number;
  dependent_repos_count: number;
  first_release_published_at?: string | null;
  latest_release_published_at: string | null;
  maintainers?: { login?: string | null; name?: string | null }[] | null;
  repo_metadata: RepoMetadata | null;
};

export type EcosystemsCommitter = {
  name?: string | null;
  email?: string | null;
  login?: string | null;
  count?: number;
};

export type EcosystemsCommitsRepository = {
  status?: string | null;
  full_name?: string;
  default_branch?: string | null;
  total_commits?: number;
  total_committers?: number;
  total_bot_commits?: number;
  total_bot_committers?: number;
  past_year_total_commits?: number;
  past_year_total_committers?: number;
  past_year_total_bot_commits?: number;
  past_year_total_bot_committers?: number;
  created_at?: string;
  updated_at?: string;
  committers?: EcosystemsCommitter[];
  past_year_committers?: EcosystemsCommitter[];
};

export type EcosystemsMaintainer = {
  login?: string | null;
  count?: number;
  url?: string | null;
};

export type EcosystemsOwner = {
  login?: string;
  kind?: string;
  name?: string | null;
  description?: string | null;
  company?: string | null;
  location?: string | null;
  website?: string | null;
  repositories_count?: number;
  total_stars?: number;
  followers?: number;
  created_at?: string;
  updated_at?: string;
};

export type EcosystemsIssuesRepository = {
  status?: string | null;
  full_name?: string;
  created_at?: string;
  updated_at?: string;
  issues_count?: number;
  pull_requests_count?: number;
  issues_closed_count?: number;
  pull_requests_closed_count?: number;
  issue_authors_count?: number;
  pull_request_authors_count?: number;
  issue_authors?: Record<string, number>;
  pull_request_authors?: Record<string, number>;
  issue_author_associations_count?: Record<string, number>;
  pull_request_author_associations_count?: Record<string, number>;
  maintainers?: EcosystemsMaintainer[];
  active_maintainers?: EcosystemsMaintainer[];
  past_year_issue_authors_count?: number;
  past_year_pull_request_authors_count?: number;
};

export type RepoInfo = {
  packages: EcosystemsPackage[];
  repository: RepoMetadata | null;
  contributors: EcosystemsCommitsRepository | null;
  issues: EcosystemsIssuesRepository | null;
  owner: EcosystemsOwner | null;
};

type RepoCacheEntry = {
  packages: EcosystemsPackage[];
  repository: RepoMetadata | null;
  contributors: EcosystemsCommitsRepository | null;
  issues: EcosystemsIssuesRepository | null;
  owner: EcosystemsOwner | null;
};

type RepoCacheRecord = RepoCacheEntry & {
  url: string;
  key: string;
  fetchedAt: string;
};

export function normalizeRepoKey(url: string): string {
  const trimmed = (url || '')
    .trim()
    .replace(/\.git$/, '')
    .replace(/\/+$/, '');
  try {
    const parsed = new URL(trimmed);
    const host = parsed.host.replace(/^www\./, '').toLowerCase();
    const pathname = parsed.pathname.replace(/\/+$/, '').replace(/\.git$/, '');
    return `${host}${pathname.toLowerCase()}`;
  } catch {
    return trimmed.toLowerCase();
  }
}

export function findRepoMetadata(packages: EcosystemsPackage[]): RepoMetadata | null {
  for (const pkg of packages) {
    if (pkg.repo_metadata && Object.keys(pkg.repo_metadata).length > 0) {
      return pkg.repo_metadata;
    }
  }
  return null;
}

async function fetchLookup<T>(apiUrl: string, url: string): Promise<T | null> {
  try {
    const response = await axios.get(`${apiUrl}/repositories/lookup`, {
      params: { url, mailto: ECOSYSTEMS_MAILTO },
    });
    return response.data;
  } catch (e) {
    if (e.response?.status === 404) {
      return null;
    }

    throw e;
  }
}

export async function fetchRepositoryLookup(url: string): Promise<RepoMetadata | null> {
  return fetchLookup(ECOSYSTEMS_REPOS_API_URL, url);
}

export async function fetchCommitsLookup(url: string): Promise<EcosystemsCommitsRepository | null> {
  return fetchLookup(ECOSYSTEMS_COMMITS_API_URL, url);
}

export async function fetchIssuesLookup(url: string): Promise<EcosystemsIssuesRepository | null> {
  return fetchLookup(ECOSYSTEMS_ISSUES_API_URL, url);
}

export async function fetchOwnerLookup(hostName: string, owner: string): Promise<EcosystemsOwner | null> {
  try {
    const response = await axios.get(
      `${ECOSYSTEMS_REPOS_API_URL}/hosts/${encodeURIComponent(hostName)}/owners/${encodeURIComponent(owner)}`,
      { params: { mailto: ECOSYSTEMS_MAILTO } },
    );
    return response.data;
  } catch (e) {
    if (e.response?.status === 404) {
      return null;
    }

    throw e;
  }
}

const ECOSYSTEMS_HOST_BY_HOSTNAME: Record<string, string> = {
  'github.com': 'GitHub',
  'gitlab.com': 'GitLab',
  'bitbucket.org': 'Bitbucket',
  'codeberg.org': 'Codeberg',
  'gitea.com': 'Gitea',
};

function hostAndOwnerFromUrl(url: string): { hostName: string; owner: string } | null {
  try {
    const parsed = new URL((url || '').trim());
    const hostName = ECOSYSTEMS_HOST_BY_HOSTNAME[parsed.host.replace(/^www\./, '').toLowerCase()];
    const owner = parsed.pathname.split('/').filter(Boolean)[0];
    return hostName && owner ? { hostName, owner } : null;
  } catch {
    return null;
  }
}

function readRepoCache(cacheDir: string, key: string): RepoCacheEntry | null {
  const cached = readJsonCache<RepoCacheRecord>(cacheDir, key);
  if (
    !cached ||
    !Array.isArray(cached.packages) ||
    !('repository' in cached) ||
    !('contributors' in cached) ||
    !('issues' in cached) ||
    !('owner' in cached)
  ) {
    return null;
  }

  // "pending" records are stubs while ecosyste.ms queues the repo for parsing: treat as stale and refetch
  if (cached.contributors?.status === 'pending' || cached.issues?.status === 'pending') {
    return null;
  }

  return {
    packages: cached.packages,
    repository: cached.repository,
    contributors: cached.contributors,
    issues: cached.issues,
    owner: cached.owner,
  };
}

function writeRepoCache(cacheDir: string, url: string, key: string, entry: RepoCacheEntry): void {
  writeJsonCache(cacheDir, key, { url, key, fetchedAt: new Date().toISOString(), ...entry });
}

export async function fetchRepoInfo(
  repoUrls: string[],
  options: { cacheDir: string; ignoreCache?: boolean },
): Promise<{ repoInfoByUrl: Map<string, RepoInfo>; fetched: number; fromCache: number }> {
  const repoInfoByUrl = new Map<string, RepoInfo>();
  const keyToUrl = new Map<string, string>();
  const ownerByKey = new Map<string, EcosystemsOwner | null>();
  const pendingKeys: string[] = [];
  let fromCache = 0;

  for (const url of repoUrls) {
    const key = normalizeRepoKey(url);
    if (keyToUrl.has(key)) {
      continue;
    }

    keyToUrl.set(key, url);
    const cached = options.ignoreCache ? null : readRepoCache(options.cacheDir, key);
    if (cached !== null) {
      repoInfoByUrl.set(key, {
        packages: cached.packages,
        repository: findRepoMetadata(cached.packages) || cached.repository,
        contributors: cached.contributors,
        issues: cached.issues,
        owner: cached.owner,
      });
      fromCache++;
    } else {
      pendingKeys.push(key);
    }
  }

  for (let i = 0; i < pendingKeys.length; i += ECOSYSTEMS_BATCH_SIZE) {
    const batchKeys = pendingKeys.slice(i, i + ECOSYSTEMS_BATCH_SIZE);
    const batchUrls = batchKeys.map((key) => keyToUrl.get(key));

    try {
      const response = await axios.post(
        `${ECOSYSTEMS_API_URL}/packages/bulk_lookup?mailto=${encodeURIComponent(ECOSYSTEMS_MAILTO)}`,
        { repository_urls: batchUrls },
      );
      const packages: EcosystemsPackage[] = response.data || [];

      const packagesByesKey = new Map<string, EcosystemsPackage[]>();
      for (const pkg of packages) {
        const key = normalizeRepoKey(pkg.repository_url || '');
        if (!packagesByesKey.has(key)) {
          packagesByesKey.set(key, []);
        }
        packagesByesKey.get(key).push(pkg);
      }

      for (const key of batchKeys) {
        const url = keyToUrl.get(key);
        const found = packagesByesKey.get(key) || [];
        const entry: RepoCacheEntry = {
          packages: found,
          repository: findRepoMetadata(found),
          contributors: null,
          issues: null,
          owner: null,
        };
        let cacheable = true;

        if (!entry.repository) {
          try {
            entry.repository = await fetchRepositoryLookup(url);
          } catch (e) {
            error(`Error fetching ecosyste.ms repository data for ${url}: ${e.message}`);
            cacheable = false;
          }

          await sleep(ECOSYSTEMS_LOOKUP_DELAY_MS);
        }

        try {
          entry.contributors = await fetchCommitsLookup(url);
        } catch (e) {
          error(`Error fetching ecosyste.ms commits data for ${url}: ${e.message}`);
          cacheable = false;
        }

        await sleep(ECOSYSTEMS_LOOKUP_DELAY_MS);

        try {
          entry.issues = await fetchIssuesLookup(url);
        } catch (e) {
          error(`Error fetching ecosyste.ms issues data for ${url}: ${e.message}`);
          cacheable = false;
        }

        await sleep(ECOSYSTEMS_LOOKUP_DELAY_MS);

        const fromUrl = hostAndOwnerFromUrl(url);
        const hostName = entry.repository?.host?.name || fromUrl?.hostName;
        const ownerLogin = entry.repository?.owner || fromUrl?.owner;
        if (hostName && ownerLogin) {
          const ownerKey = `${hostName}/${ownerLogin}`;
          if (ownerByKey.has(ownerKey)) {
            entry.owner = ownerByKey.get(ownerKey);
          } else {
            try {
              entry.owner = await fetchOwnerLookup(hostName, ownerLogin);
            } catch (e) {
              error(`Error fetching ecosyste.ms owner data for ${hostName}/${ownerLogin}: ${e.message}`);
              cacheable = false;
            }

            ownerByKey.set(ownerKey, entry.owner);
            await sleep(ECOSYSTEMS_LOOKUP_DELAY_MS);
          }
        }

        repoInfoByUrl.set(key, entry);
        if (cacheable) {
          writeRepoCache(options.cacheDir, url, key, entry);
        }
      }
    } catch (e) {
      error(`Error fetching ecosyste.ms data for ${batchUrls.length} repository URL(s): ${e.message}`);
    }
  }

  return { repoInfoByUrl, fetched: pendingKeys.length, fromCache };
}
