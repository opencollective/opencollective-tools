require('../env');

const fs = require('fs');
const path = require('path');

const { Command } = require('commander');

const { request, gql } = require('graphql-request');

const { fetchRepoInfo, normalizeRepoKey } = require('../lib/ecosyste.ms.ts');
const { debug, error, info } = require('../lib/log.ts');

import type { RepoInfo } from '../lib/ecosyste.ms.ts';

const endpoint = process.env.PERSONAL_TOKEN
  ? `${process.env.API_URL}/graphql?personalToken=${process.env.PERSONAL_TOKEN}`
  : `${process.env.API_URL}/graphql/${process.env.API_KEY}`;

const PAGE_SIZE = 100;
const CACHE_DIR = path.join(__dirname, '.cache');

const pendingHostApplicationsQuery = gql`
  query PendingHostApplications($limit: Int!, $offset: Int!) {
    host(slug: "opensource") {
      id
      slug
      name
      hostApplications(
        status: PENDING
        limit: $limit
        offset: $offset
        orderBy: { field: CREATED_AT, direction: ASC }
      ) {
        totalCount
        nodes {
          id
          publicId
          createdAt
          message
          customData
          account {
            id
            legacyId
            name
            slug
            type
            createdAt
            description
            website
          }
          comments {
            totalCount
          }
        }
      }
    }
  }
`;

type PendingHostApplicationAccount = {
  id: string;
  legacyId: number;
  name: string;
  slug: string;
  type: string;
  createdAt: string;
  description?: string;
  website?: string;
};

type PendingHostApplication = {
  id: string;
  publicId: string;
  createdAt: string;
  message?: string;
  customData?: Record<string, any> | null;
  account: PendingHostApplicationAccount;
  comments?: { totalCount: number };
};

type FetchResult = {
  host: { id: string; slug: string; name: string };
  applications: PendingHostApplication[];
  totalCount: number;
};

type RuleOutcome = 'pass' | 'fail' | 'unverified';

type Rule = {
  name: string;
  label: string;
  test: (application: PendingHostApplication, repoInfo?: RepoInfo) => RuleOutcome;
};

type RuleResult = {
  verdict: RuleOutcome;
  checks: { rule: Rule; outcome: RuleOutcome }[];
  passed: Rule[];
  failed: Rule[];
  unverified: Rule[];
};

const THREE_MONTHS_MS = 90 * 24 * 60 * 60 * 1000;

const isBotLogin = (login?: string | null) => !!login && /\[bot\]$/i.test(login);

const countHumanAuthors = (authors?: Record<string, number> | null): number | null => {
  if (!authors || typeof authors !== 'object') {
    return null;
  }

  return Object.keys(authors).filter((login) => !isBotLogin(login)).length;
};

const personCount = (repoInfo?: RepoInfo, countIssueAndPullRequestAuthors: boolean = false): number | null => {
  const counts = [];

  const repoCommitters = repoInfo?.repository?.commit_stats?.total_committers;
  if (typeof repoCommitters === 'number') {
    counts.push(repoCommitters);
  }

  for (const pkg of repoInfo?.packages || []) {
    const pkgCommitters = pkg.repo_metadata?.commit_stats?.total_committers;
    if (typeof pkgCommitters === 'number') {
      counts.push(pkgCommitters);
    }

    if (Array.isArray(pkg.maintainers)) {
      counts.push(pkg.maintainers.length);
    }
  }

  const contributors = repoInfo?.contributors;
  if (contributors) {
    if (typeof contributors.total_committers === 'number') {
      counts.push(contributors.total_committers - (contributors.total_bot_committers || 0));
    }

    if (typeof contributors.past_year_total_committers === 'number') {
      counts.push(contributors.past_year_total_committers - (contributors.past_year_total_bot_committers || 0));
    }
  }

  const issues = repoInfo?.issues;
  if (countIssueAndPullRequestAuthors && issues) {
    if (Array.isArray(issues.maintainers)) {
      counts.push(issues.maintainers.filter((maintainer) => !isBotLogin(maintainer.login)).length);
    }

    if (Array.isArray(issues.active_maintainers)) {
      counts.push(issues.active_maintainers.filter((maintainer) => !isBotLogin(maintainer.login)).length);
    }

    if (countIssueAndPullRequestAuthors) {
      const humanIssueAuthors = countHumanAuthors(issues.issue_authors);
      if (humanIssueAuthors !== null) {
        counts.push(humanIssueAuthors);
      }

      const humanPullRequestAuthors = countHumanAuthors(issues.pull_request_authors);
      if (humanPullRequestAuthors !== null) {
        counts.push(humanPullRequestAuthors);
      }
    }
  }

  return counts.length > 0 ? Math.max(...counts) : null;
};

const oldestProjectTimestamp = (repoInfo?: RepoInfo): number | null => {
  const timestamps = [];

  if (repoInfo?.repository?.created_at) {
    timestamps.push(new Date(repoInfo.repository.created_at).getTime());
  }

  for (const pkg of repoInfo?.packages || []) {
    if (pkg.first_release_published_at) {
      timestamps.push(new Date(pkg.first_release_published_at).getTime());
    }
  }

  const valid = timestamps.filter((time) => !isNaN(time));
  return valid.length > 0 ? Math.min(...valid) : null;
};

const usageCounts = (repoInfo?: RepoInfo): number[] => {
  const values = [];

  if (typeof repoInfo?.repository?.forks_count === 'number') {
    values.push(repoInfo.repository.forks_count);
  }

  for (const pkg of repoInfo?.packages || []) {
    if (typeof pkg.dependent_repos_count === 'number') {
      values.push(pkg.dependent_repos_count);
    }

    if (typeof pkg.dependent_packages_count === 'number') {
      values.push(pkg.dependent_packages_count);
    }
  }

  return values;
};

const noUsageRule = (countIssueAndPullRequestAuthors: boolean): Rule => ({
  name: 'no-usage',
  label: '1 maintainer and no usage (dependents or forks)',
  test: (application, repoInfo) => {
    const person = personCount(repoInfo, countIssueAndPullRequestAuthors);
    const usage = usageCounts(repoInfo);

    if (person !== null && person !== 1) {
      return 'pass';
    }

    if (usage.some((value) => value > 0)) {
      return 'pass';
    }

    if (person === 1 && usage.length > 0 && usage.every((value) => value === 0)) {
      return 'fail';
    }

    return 'unverified';
  },
});

const youngSmallRule = (countIssueAndPullRequestAuthors: boolean): Rule => ({
  name: 'young-small',
  label: 'fewer than 5 contributors and younger than 3 months',
  test: (application, repoInfo) => {
    const person = personCount(repoInfo, countIssueAndPullRequestAuthors);
    const oldest = oldestProjectTimestamp(repoInfo);
    const young = oldest === null ? null : oldest > Date.now() - THREE_MONTHS_MS;

    if ((person !== null && person < 5) || young === true) {
      return 'fail';
    }

    if (person !== null && person >= 5) {
      return 'pass';
    }

    if (young === false) {
      return 'pass';
    }

    return 'unverified';
  },
});

const inactiveRule: Rule = {
  name: 'inactive',
  label: 'no activity in the last 3 months',
  test: (application, repoInfo) => {
    const pushedAt = repoInfo?.repository?.pushed_at;
    if (pushedAt) {
      const pushed = new Date(pushedAt).getTime();
      if (!isNaN(pushed)) {
        return pushed < Date.now() - THREE_MONTHS_MS ? 'fail' : 'pass';
      }
    }

    const pastYearCommits = repoInfo?.contributors?.past_year_total_commits;
    if (typeof pastYearCommits === 'number') {
      return pastYearCommits === 0 ? 'fail' : 'pass';
    }

    return 'unverified';
  },
};

const personalAccountRule: Rule = {
  name: 'personal-account',
  label: 'not under an org account',
  test: (application, repoInfo) => {
    const kind = repoInfo?.owner?.kind;
    if (!kind) {
      return 'unverified';
    }

    return kind === 'organization' ? 'pass' : 'fail';
  },
};

const RULES: Rule[] = [noUsageRule(), youngSmallRule(), inactiveRule, personalAccountRule];

function evaluateRules(application: PendingHostApplication, repoInfo?: RepoInfo, rules: Rule[] = RULES): RuleResult {
  const checks = rules.map((rule) => ({ rule, outcome: rule.test(application, repoInfo) }));
  const passed = checks.filter((check) => check.outcome === 'pass').map((check) => check.rule);
  const failed = checks.filter((check) => check.outcome === 'fail').map((check) => check.rule);
  const unverified = checks.filter((check) => check.outcome === 'unverified').map((check) => check.rule);

  const verdict = failed.length > 0 ? 'fail' : passed.length > 0 ? 'pass' : 'unverified';
  return { verdict, checks, passed, failed, unverified };
}

const catchException = (e) => {
  debug(e);
  return null;
};

async function fetchPendingHostApplications(limit?: number): Promise<FetchResult | null> {
  const applications: PendingHostApplication[] = [];
  let totalCount = 0;
  let host = null;
  let offset = 0;

  while (true) {
    const requestLimit = limit ? Math.min(PAGE_SIZE, limit - applications.length) : PAGE_SIZE;
    const data = await request(endpoint, pendingHostApplicationsQuery, {
      limit: requestLimit,
      offset,
    }).catch(catchException);

    if (!data?.host?.hostApplications) {
      error(
        `Error fetching pending applications. Make sure PERSONAL_TOKEN belongs to an admin of the Open Source Collective.`,
      );
      return null;
    }

    host = data.host;
    totalCount = data.host.hostApplications.totalCount;
    const nodes = data.host.hostApplications.nodes || [];
    applications.push(...nodes);
    offset += nodes.length;

    if (nodes.length === 0 || applications.length >= totalCount || (limit && applications.length >= limit)) {
      break;
    }
  }

  return { host, applications, totalCount };
}

function getRepositoryUrls(applications: PendingHostApplication[]): string[] {
  const urls: string[] = [];
  for (const application of applications) {
    const url = application.customData?.repositoryUrl;
    if (typeof url === 'string' && url.trim()) {
      urls.push(url.trim());
    }
  }
  return urls;
}

function formatVerdict(result: RuleResult): string {
  const states = result.checks.map((check) => `${check.rule.name}=${check.outcome}`).join(', ');
  const verdict = result.verdict === 'pass' ? 'PASS' : result.verdict === 'fail' ? 'FAIL' : 'UNVERIFIED';
  return ` [${verdict}: ${states}]`;
}

function formatApplicationLine(
  application: PendingHostApplication,
  repoInfo: RepoInfo | undefined,
  result: RuleResult,
): string {
  const { account, customData, message } = application;
  const created = application.createdAt.slice(0, 10);
  const signals = [];

  if (customData?.typeOfProject) {
    signals.push(`type=${customData.typeOfProject}`);
  }

  const repositoryUrl = typeof customData?.repositoryUrl === 'string' ? customData.repositoryUrl.trim() : null;
  if (repositoryUrl) {
    signals.push(`repo=${repositoryUrl}`);
    if (!repoInfo) {
      signals.push('repo-info=pending');
    } else {
      if (repoInfo.packages.length > 0) {
        signals.push(`pkgs=${repoInfo.packages.length}`);
      }

      const metadata = repoInfo.repository;
      if (metadata) {
        if (typeof metadata.stargazers_count === 'number') {
          signals.push(`stars=${metadata.stargazers_count}`);
        }
        if (metadata.pushed_at) {
          signals.push(`pushed=${metadata.pushed_at.slice(0, 10)}`);
        }
        if (metadata.archived) {
          signals.push('archived');
        }
        if (metadata.fork) {
          signals.push('fork');
        }
      } else {
        signals.push('repo-info=not-found');
      }
    }
  }

  if (customData?.hasLegalEntity) {
    signals.push('has-legal-entity');
  }

  if (message) {
    signals.push(`message=${message.length}c`);
  }

  if (application.comments?.totalCount) {
    signals.push(`comments=${application.comments.totalCount}`);
  }

  const suffix = signals.length ? ` [${signals.join(', ')}]` : '';
  return `${created}  ${account.slug}  "${account.name}"${suffix}${formatVerdict(result)}`;
}

const CSV_COLUMNS = [
  'permalink',
  'public_id',
  'account_name',
  'account_slug',
  'account_type',
  'applied_at',
  'type_of_project',
  'repository_url',
  'license',
  'has_legal_entity',
  'contributors',
  'months_old',
  'forks',
  'is_fork',
  'dependent_repos',
  'dependent_packages',
  'last_activity',
  'owner_kind',
];

function csvCell(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }

  const str = typeof value === 'boolean' ? (value ? 'true' : 'false') : String(value);
  return /["\n\r,]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

function monthsOld(repoInfo?: RepoInfo): number | null {
  const oldest = oldestProjectTimestamp(repoInfo);
  return oldest === null ? null : Math.round(((Date.now() - oldest) / (THREE_MONTHS_MS / 3)) * 10) / 10;
}

function applicationToCsvRow(application: PendingHostApplication, repoInfo?: RepoInfo): unknown[] {
  const customData = application.customData || {};
  const dependentRepos =
    repoInfo && repoInfo.packages.length > 0
      ? repoInfo.packages.reduce((sum, pkg) => sum + (pkg.dependent_repos_count || 0), 0)
      : null;
  const dependentPackages =
    repoInfo && repoInfo.packages.length > 0
      ? repoInfo.packages.reduce((sum, pkg) => sum + (pkg.dependent_packages_count || 0), 0)
      : null;

  return [
    application.publicId ? `http://opencollective.com/permalink/${application.publicId}` : '',
    application.publicId || '',
    application.account.name,
    application.account.slug,
    application.account.type,
    application.createdAt.slice(0, 10),
    customData.typeOfProject ?? '',
    customData.repositoryUrl ?? '',
    customData.licenseSpdxId ?? '',
    customData.hasLegalEntity ?? '',
    personCount(repoInfo) ?? '',
    monthsOld(repoInfo) ?? '',
    repoInfo?.repository?.forks_count ?? '',
    repoInfo?.repository?.fork ?? '',
    dependentRepos ?? '',
    dependentPackages ?? '',
    repoInfo?.repository?.pushed_at ? repoInfo.repository.pushed_at.slice(0, 10) : '',
    repoInfo?.owner?.kind ?? '',
  ];
}

function writeApplicationsCsv(
  evaluations: { application: PendingHostApplication; repoInfo?: RepoInfo }[],
  filePath: string,
): void {
  const lines = [CSV_COLUMNS.join(',')];
  for (const { application, repoInfo } of evaluations) {
    lines.push(applicationToCsvRow(application, repoInfo).map(csvCell).join(','));
  }

  fs.writeFileSync(filePath, lines.join('\n') + '\n');
}

async function main(argv = process.argv) {
  const program = getProgram(argv);
  const options = program.opts();

  const result = await fetchPendingHostApplications(options.limit);
  if (!result) {
    process.exitCode = 1;
    return;
  }

  const { host, applications, totalCount } = result;
  info(`Found ${totalCount} pending application(s) for ${host.name} (${host.slug}).`);

  const repositoryUrls = getRepositoryUrls(applications);
  const { repoInfoByUrl, fetched, fromCache } = await fetchRepoInfo(repositoryUrls, {
    cacheDir: CACHE_DIR,
    ignoreCache: options.ignoreCache,
  });
  info(
    `Ecosyste.ms: ${new Set(repositoryUrls.map(normalizeRepoKey)).size} repository URL(s), ${fromCache} from cache, ${fetched} fetched.`,
  );

  const evaluations = applications.map((application) => {
    const repositoryUrl =
      typeof application.customData?.repositoryUrl === 'string' ? application.customData.repositoryUrl.trim() : null;
    const repoInfo = repositoryUrl ? repoInfoByUrl.get(normalizeRepoKey(repositoryUrl)) : undefined;
    return { application, repoInfo, result: evaluateRules(application, repoInfo) };
  });

  for (const { application, repoInfo, result } of evaluations) {
    debug(formatApplicationLine(application, repoInfo, result));
  }

  if (applications.length < totalCount) {
    info(`Fetched ${applications.length} of ${totalCount} (limit reached).`);
  }

  const verdictCounts = { pass: 0, fail: 0, unverified: 0 };
  const failCountByRule = new Map<string, number>();
  const failCountByCombination = new Map<string, number>();
  let withPackageInfo = 0;
  let withRepositoryInfoOnly = 0;
  let withoutRepoInfo = 0;

  for (const { repoInfo, result } of evaluations) {
    verdictCounts[result.verdict]++;
    if (repoInfo && repoInfo.packages.length > 0) {
      withPackageInfo++;
    } else if (repoInfo && repoInfo.repository) {
      withRepositoryInfoOnly++;
    } else {
      withoutRepoInfo++;
    }

    for (const rule of result.failed) {
      failCountByRule.set(rule.name, (failCountByRule.get(rule.name) || 0) + 1);
    }

    if (result.failed.length > 0) {
      const combination = result.failed.map((rule) => rule.name).join(' + ');
      failCountByCombination.set(combination, (failCountByCombination.get(combination) || 0) + 1);
    }
  }

  info(
    `Rules (${RULES.map((rule) => rule.label).join('; ')}): passed ${verdictCounts.pass}, failed ${verdictCounts.fail}, unverified ${verdictCounts.unverified} (of ${evaluations.length}).`,
  );
  info(`Failures by rule: ${RULES.map((rule) => `${rule.name}=${failCountByRule.get(rule.name) || 0}`).join(', ')}.`);
  info(`Failures by combination:`);
  const combinations = [...failCountByCombination.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  for (const [combination, count] of combinations) {
    info(`  ${count} x ${combination}`);
  }
  info(
    `Ecosyste.ms data: ${withPackageInfo} with package info, ${withRepositoryInfoOnly} with repository info only, ${withoutRepoInfo} without repo info.`,
  );

  const csvPath = options.csv || path.join(__dirname, 'applications.csv');
  writeApplicationsCsv(evaluations, csvPath);
  info(`Wrote ${evaluations.length} application(s) to ${csvPath}.`);
}

const getProgram = (argv) => {
  const program = new Command();
  program.exitOverride();
  program.showSuggestionAfterError();

  program.option('--limit <n>', 'Maximum number of applications to fetch', (value) => parseInt(value, 10));
  program.option('--ignore-cache', 'Ignore the local ecosyste.ms cache and refetch from the API');
  program.option('--csv <path>', 'Path for the CSV export');

  program.parse(argv);

  return program;
};

if (!module.parent) {
  main()
    .then(() => process.exit())
    .catch((e) => {
      if (e.name !== 'CommanderError') {
        error(e);
      }

      process.exit(1);
    });
}
