require('../env');

const fs = require('fs');
const path = require('path');

const { Command } = require('commander');

const { request, gql } = require('graphql-request');

const { fetchRepoInfo, normalizeRepoKey } = require('../lib/ecosyste.ms.ts');
const { debug, error, info, warn } = require('../lib/log.ts');
const { sleep } = require('../lib/utils.ts');

import type { RepoInfo } from '../lib/ecosyste.ms.ts';

import type {
  ApplicationFacts,
  RepositoryInfoState,
  RepositorySnapshot,
  RuleFlag,
  RuleId,
  RuleMetrics,
  RuleSeverity,
} from './application-rules.ts';

const {
  evaluateApplication,
  flagsBySeverity,
  getContributors,
  getProjectAgeInMonths,
  getRuleMetrics,
  pickPrimaryError,
  RULE_MESSAGES,
  toRepositorySnapshot,
} = require('./application-rules.ts');

const endpoint = process.env.PERSONAL_TOKEN
  ? `${process.env.API_URL}/graphql?personalToken=${process.env.PERSONAL_TOKEN}`
  : `${process.env.API_URL}/graphql/${process.env.API_KEY}`;

const PAGE_SIZE = 100;
const CACHE_DIR = path.join(__dirname, '.cache');
// Delay between rejection mutations when running with --apply
const APPLY_DELAY_MS = 500;

const processHostApplicationMutation = gql`
  mutation ProcessHostApplication(
    $hostApplication: HostApplicationReferenceInput!
    $action: ProcessHostApplicationAction!
    $message: String
  ) {
    processHostApplication(hostApplication: $hostApplication, action: $action, message: $message) {
      hostApplication {
        id
        status
      }
    }
  }
`;

const pendingHostApplicationsQuery = gql`
  query PendingHostApplications($limit: Int!, $offset: Int!) {
    host(slug: "opensource") {
      id
      slug
      name
      members(role: [ADMIN]) {
        nodes {
          id
          account {
            id
            slug
          }
        }
      }
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
            members(role: [ADMIN]) {
              totalCount
            }
            memberInvitations(role: [ADMIN]) {
              id
            }
          }
          comments(limit: 100) {
            totalCount
            nodes {
              id
              createdAt
              fromAccount {
                id
                slug
              }
            }
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
  members?: { totalCount: number };
  memberInvitations?: { id: string }[];
};

type HostApplicationComment = {
  id: string;
  createdAt?: string;
  fromAccount?: { id: string; slug: string } | null;
};

/** A fiscal host admin, used to tell whether a comment came from the host team */
type HostAdminMember = {
  id: string;
  account?: { id: string; slug: string } | null;
};

type PendingHostApplication = {
  id: string;
  publicId: string;
  createdAt: string;
  message?: string;
  customData?: Record<string, any> | null;
  account: PendingHostApplicationAccount;
  comments?: { totalCount: number; nodes: HostApplicationComment[] };
};

type FetchResult = {
  host: { id: string; slug: string; name: string; members?: { nodes: HostAdminMember[] } };
  applications: PendingHostApplication[];
  totalCount: number;
};

/** Triaged application: the flags the shared rules produce for it */
type Evaluation = {
  application: PendingHostApplication;
  repoInfo?: RepoInfo;
  snapshot: RepositorySnapshot | null;
  facts: ApplicationFacts;
  /** The properties the rules branched on, for the debug output */
  metrics: RuleMetrics;
  flags: RuleFlag[];
  verdict: Verdict;
  /** The single error we would pass down to the rejection (null when not blocked) */
  primaryError: RuleFlag | null;
  /** Comments left by a fiscal host admin */
  adminCommentCount: number;
  /** True when a fiscal host admin already commented on the application */
  interacted: boolean;
};

/**
 * `block` = the application form would block the submission (errors), `warn` = issues to
 * review but submittable, `unverified` = we could not verify the repository automatically,
 * `pass` = no issue. Only `block` means "will not be approved as is".
 */
type Verdict = 'block' | 'warn' | 'unverified' | 'pass';

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

/** Account slugs to leave alone, from the `--ignore` option */
function parseIgnoredSlugs(ignore?: string): Set<string> {
  return new Set(
    (ignore || '')
      .split(',')
      .map((slug) => slug.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** Rejects an application through `processHostApplication`, attaching the picked error message as the reason */
async function rejectApplication(application: PendingHostApplication, message: string): Promise<void> {
  await request(endpoint, processHostApplicationMutation, {
    hostApplication: { id: application.publicId },
    action: 'REJECT',
    message,
  });
}

/** Rejects every blocked application with its picked error message. Failures are logged and skipped. */
async function applyRejections(rejections: Evaluation[]): Promise<{ rejected: number; failed: number }> {
  let rejected = 0;
  let failed = 0;

  for (const { application, primaryError } of rejections) {
    try {
      await rejectApplication(application, RULE_MESSAGES[primaryError.id]);
      rejected++;
      info(`Rejected ${application.account.slug} "${application.account.name}" (${primaryError.id}).`);
    } catch (e) {
      failed++;
      error(`Failed to reject ${application.account.slug} (${primaryError.id}): ${e.message}`);
    }

    await sleep(APPLY_DELAY_MS);
  }

  return { rejected, failed };
}

function repositoryInfoState(repositoryUrl?: string | null, repoInfo?: RepoInfo): RepositoryInfoState {
  const url = (repositoryUrl || '').trim();
  if (!url) {
    return 'idle';
  } else if (!repoInfo) {
    // The lookup itself failed (network, rate limit, batch error...)
    return 'error';
  }
  return repoInfo.repository ? 'found' : 'not-found';
}

function applicationFacts(application: PendingHostApplication, repoInfo?: RepoInfo): ApplicationFacts {
  const customData = application.customData || {};
  const admins = application.account.members?.totalCount || 0;
  const invitations = application.account.memberInvitations?.length || 0;

  return {
    typeOfProject: customData.typeOfProject ?? null,
    repositoryUrl: customData.repositoryUrl ?? null,
    name: application.account.name,
    message: application.message ?? '',
    description: application.account.description ?? '',
    teamSize: Math.max(1, admins + invitations),
    // The application was submitted: the text rules always apply
    applicationTextEngaged: true,
    repositoryInfoState: repositoryInfoState(customData.repositoryUrl, repoInfo),
    repository: repoInfo ? toRepositorySnapshot(repoInfo) : null,
  };
}

function evaluate(
  application: PendingHostApplication,
  repoInfo: RepoInfo | undefined,
  adminAccountIds: Set<string>,
): Evaluation {
  const snapshot = repoInfo ? toRepositorySnapshot(repoInfo) : null;
  const facts = applicationFacts(application, repoInfo);
  const metrics = getRuleMetrics(facts);
  const flags = evaluateApplication(facts);
  const errors = flagsBySeverity(flags, 'error');
  const warnings = flagsBySeverity(flags, 'warning');
  const infos = flagsBySeverity(flags, 'info');
  const adminComments = hostAdminComments(application, adminAccountIds);

  return {
    application,
    repoInfo,
    snapshot,
    facts,
    metrics,
    flags,
    verdict: errors.length > 0 ? 'block' : warnings.length > 0 ? 'warn' : infos.length > 0 ? 'unverified' : 'pass',
    primaryError: pickPrimaryError(flags),
    adminCommentCount: adminComments.length,
    interacted: adminComments.length > 0,
  };
}

/** Account ids of the fiscal host team: the host account itself plus its admins */
function hostAdminAccountIds(host: FetchResult['host']): Set<string> {
  const ids = new Set<string>();
  if (host?.id) {
    ids.add(host.id);
  }

  for (const member of host?.members?.nodes || []) {
    if (member.account?.id) {
      ids.add(member.account.id);
    }
  }

  return ids;
}

/** Comments left by the fiscal host team on an application */
function hostAdminComments(
  application: PendingHostApplication,
  adminAccountIds: Set<string>,
): HostApplicationComment[] {
  return (application.comments?.nodes || []).filter((comment) =>
    Boolean(comment.fromAccount?.id && adminAccountIds.has(comment.fromAccount.id)),
  );
}

function flagIds(flags: RuleFlag[]): RuleId[] {
  return flags.map((flag) => flag.id);
}

function formatFlag(flag: RuleFlag): string {
  return `${flag.id}${flag.requiresConfirmation ? '^' : ''}`;
}

function formatVerdict(flags: RuleFlag[], verdict: Verdict): string {
  const states = flags.map(formatFlag).join(', ');
  return ` [${verdict.toUpperCase()}${states ? `: ${states}` : ''}]`;
}

function formatApplicationLine(evaluation: Evaluation): string {
  const { application, repoInfo, flags, verdict, adminCommentCount } = evaluation;
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

  if (adminCommentCount > 0) {
    signals.push(`admin-comments=${adminCommentCount}`);
  }

  const suffix = signals.length ? ` [${signals.join(', ')}]` : '';
  return `${created}  ${account.slug}  "${account.name}"${suffix}${formatVerdict(flags, verdict)}`;
}

function formatNumber(value: number | null): string {
  return value === null ? '?' : String(Math.round(value * 10) / 10);
}

/** The properties the rules used to reach the verdict (see `getRuleMetrics`) */
function formatFactsLine({ metrics }: Evaluation): string {
  const parts = [
    `state=${metrics.repositoryInfoState}`,
    `type=${metrics.typeOfProject ?? '?'}`,
    `owner=${metrics.ownerKind ?? '?'}`,
    `license=${metrics.license ?? '?'}`,
    `contributors=${metrics.contributors ?? '?'}`,
    `usage=${metrics.usage ?? '?'}`,
    `ageMonths=${formatNumber(metrics.ageInMonths)}`,
    `lastCommitMonths=${formatNumber(metrics.monthsSinceLastCommit)}`,
    `teamSize=${metrics.teamSize}`,
    `message=${metrics.messageLength}c`,
    `description=${metrics.hasDescription ? 'yes' : 'no'}`,
    `topics=${metrics.topics.length > 0 ? metrics.topics.join('|') : '?'}`,
    metrics.applicationTextEngaged && 'textEngaged',
    metrics.noCommunity && 'noCommunity',
    metrics.weak && 'weak',
    metrics.onPersonalAccount && 'onPersonalAccount',
    metrics.communityMitigated && 'communityMitigated',
    metrics.isFork && 'isFork',
    metrics.archived && 'archived',
  ].filter(Boolean);
  return `  facts: [${parts.join(', ')}]`;
}

/** The messages we would send the applicant for the flagged rules, errors first */
function formatMessageLines({ flags, primaryError }: Evaluation): string[] {
  return [
    ...flagsBySeverity(flags, 'error'),
    ...flagsBySeverity(flags, 'warning'),
    ...flagsBySeverity(flags, 'info'),
  ].map(
    (flag) =>
      `  message ${flag.severity} ${flag.id}${flag.id === primaryError?.id ? ' (primary)' : ''}: ${RULE_MESSAGES[flag.id]}`,
  );
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
  'verdict',
  'errors',
  'warnings',
  'infos',
  'primary_error',
  'admin_comments',
];

function csvCell(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }

  const str = typeof value === 'boolean' ? (value ? 'true' : 'false') : String(value);
  return /["\n\r,]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

function applicationToCsvRow({
  application,
  snapshot,
  flags,
  verdict,
  primaryError,
  adminCommentCount,
}: Evaluation): unknown[] {
  const customData = application.customData || {};

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
    getContributors(snapshot) ?? '',
    getProjectAgeInMonths(snapshot) ?? '',
    snapshot?.forks ?? '',
    snapshot?.isFork ?? '',
    snapshot && snapshot.packages.length > 0
      ? snapshot.packages.reduce((sum, pkg) => sum + (pkg.dependentReposCount || 0), 0)
      : null,
    snapshot && snapshot.packages.length > 0
      ? snapshot.packages.reduce((sum, pkg) => sum + (pkg.dependentPackagesCount || 0), 0)
      : null,
    snapshot?.lastCommitAt ? snapshot.lastCommitAt.slice(0, 10) : '',
    snapshot?.ownerKind ?? '',
    verdict,
    flagIds(flagsBySeverity(flags, 'error')).join(';'),
    flagIds(flagsBySeverity(flags, 'warning')).join(';'),
    flagIds(flagsBySeverity(flags, 'info')).join(';'),
    primaryError?.id ?? '',
    adminCommentCount,
  ];
}

function writeApplicationsCsv(evaluations: Evaluation[], filePath: string): void {
  const lines = [CSV_COLUMNS.join(',')];
  for (const evaluation of evaluations) {
    lines.push(applicationToCsvRow(evaluation).map(csvCell).join(','));
  }

  fs.writeFileSync(filePath, lines.join('\n') + '\n');
}

function countByRule(counts: Map<string, number>, flags: RuleFlag[], severity: RuleSeverity): void {
  for (const flag of flagsBySeverity(flags, severity)) {
    counts.set(flag.id, (counts.get(flag.id) || 0) + 1);
  }
}

async function main(argv = process.argv) {
  const program = getProgram(argv);
  const options = program.opts();

  const result = await fetchPendingHostApplications(options.limit);
  if (!result) {
    process.exitCode = 1;
    return;
  }

  const { host, applications: allApplications, totalCount } = result;
  info(`Found ${totalCount} pending application(s) for ${host.name} (${host.slug}).`);

  // Fiscal host team, to tell whether an application was already interacted with
  const adminAccountIds = hostAdminAccountIds(host);

  // Applications we were asked to leave alone: not evaluated, not exported, no action taken
  const ignoredSlugs = parseIgnoredSlugs(options.ignore);
  const applications = allApplications.filter(
    (application) => !ignoredSlugs.has(application.account.slug.toLowerCase()),
  );
  if (applications.length !== allApplications.length) {
    const ignored = allApplications
      .filter((application) => ignoredSlugs.has(application.account.slug.toLowerCase()))
      .map((application) => application.account.slug);
    info(`Ignoring ${ignored.length} application(s): ${ignored.join(', ')}.`);
  }

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
    return evaluate(application, repoInfo, adminAccountIds);
  });

  for (const evaluation of evaluations) {
    debug(formatApplicationLine(evaluation));
    debug(formatFactsLine(evaluation));
    for (const messageLine of formatMessageLines(evaluation)) {
      debug(messageLine);
    }
  }

  if (applications.length < totalCount) {
    info(`Fetched ${applications.length} of ${totalCount} (limit reached).`);
  }

  const verdictCounts: Record<Verdict, number> = { block: 0, warn: 0, unverified: 0, pass: 0 };
  const severityCounts: Record<RuleSeverity, number> = { error: 0, warning: 0, info: 0 };
  const errorCountByRule = new Map<string, number>();
  const warningCountByRule = new Map<string, number>();
  const failCountByCombination = new Map<string, number>();
  let withPackageInfo = 0;
  let withRepositoryInfoOnly = 0;
  let withoutRepoInfo = 0;

  for (const { repoInfo, flags, verdict } of evaluations) {
    verdictCounts[verdict]++;
    if (repoInfo && repoInfo.packages.length > 0) {
      withPackageInfo++;
    } else if (repoInfo && repoInfo.repository) {
      withRepositoryInfoOnly++;
    } else {
      withoutRepoInfo++;
    }

    severityCounts.error += flagsBySeverity(flags, 'error').length;
    severityCounts.warning += flagsBySeverity(flags, 'warning').length;
    severityCounts.info += flagsBySeverity(flags, 'info').length;
    countByRule(errorCountByRule, flags, 'error');
    countByRule(warningCountByRule, flags, 'warning');

    const errors = flagIds(flagsBySeverity(flags, 'error')).sort();
    if (errors.length > 0) {
      const combination = errors.join(' + ');
      failCountByCombination.set(combination, (failCountByCombination.get(combination) || 0) + 1);
    }
  }

  info(
    `Rules (see application-rules.ts): blocked ${verdictCounts.block}, warned ${verdictCounts.warn}, unverified ${verdictCounts.unverified}, clean ${verdictCounts.pass} (of ${evaluations.length}).`,
  );
  info(
    `Flags by severity: error=${severityCounts.error}, warning=${severityCounts.warning}, info=${severityCounts.info}.`,
  );
  const printCounts = (label: string, counts: Map<string, number>) => {
    const entries = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    info(`${label}${entries.length ? ` ${entries.map(([id, count]) => `${id}=${count}`).join(', ')}` : ' none'}.`);
  };
  printCounts('Errors by rule:', errorCountByRule);
  printCounts('Warnings by rule:', warningCountByRule);
  info(`Errors by combination:`);
  const combinations = [...failCountByCombination.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  for (const [combination, count] of combinations) {
    info(`  ${count} x ${combination}`);
  }
  info(
    `Ecosyste.ms data: ${withPackageInfo} with package info, ${withRepositoryInfoOnly} with repository info only, ${withoutRepoInfo} without repo info.`,
  );

  const interacted = evaluations.filter((evaluation) => evaluation.interacted);
  const notInteracted = evaluations.filter((evaluation) => !evaluation.interacted);
  // Applications we would not reject (warnings only) and that nobody from the host team has
  // followed up on yet: a warning message is all we would send them.
  const warningCandidates = notInteracted.filter((evaluation) => evaluation.verdict === 'warn');
  info(
    `Host admin interaction: ${interacted.length} of ${evaluations.length} application(s) have a comment from a fiscal host admin; ${notInteracted.length} have not been interacted with.`,
  );
  info(
    `Could receive a warning: ${warningCandidates.length} uninteracted application(s) have warnings only (not blocked, so a warning message is all we would send).`,
  );

  const csvPath = options.csv || path.join(__dirname, 'applications.csv');
  writeApplicationsCsv(evaluations, csvPath);
  info(`Wrote ${evaluations.length} application(s) to ${csvPath}.`);

  // Dry run (default): report the rejections we would perform, one picked error per application.
  // Applications with warnings only are left alone. With --apply, the same list is actually rejected.
  const rejections = evaluations.filter((evaluation) => evaluation.primaryError !== null);
  const leftAlone = evaluations.length - rejections.length;

  if (!options.apply) {
    info(`DRY RUN: ${rejections.length} application(s) would be rejected (${leftAlone} left alone):`);
    for (const { application, primaryError } of rejections) {
      info(`  ${application.account.slug} "${application.account.name}" -> ${primaryError.id}`);
      info(`    ${RULE_MESSAGES[primaryError.id]}`);
    }

    info(`DRY RUN: ${warningCandidates.length} uninteracted application(s) could receive a warning:`);
    for (const { application, flags } of warningCandidates) {
      const warnings = flagIds(flagsBySeverity(flags, 'warning')).join(', ');
      info(`  ${application.account.slug} "${application.account.name}" -> ${warnings}`);
    }
    return;
  }

  warn(`APPLY MODE: rejecting ${rejections.length} application(s) (${leftAlone} left alone):`);
  for (const { application, primaryError } of rejections) {
    warn(`  ${application.account.slug} "${application.account.name}" -> ${primaryError.id}`);
  }

  const { rejected, failed } = await applyRejections(rejections);
  info(`Rejected ${rejected} application(s)${failed > 0 ? `, ${failed} failed` : ''}.`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

const getProgram = (argv) => {
  const program = new Command();
  program.exitOverride();
  program.showSuggestionAfterError();

  program.option('--limit <n>', 'Maximum number of applications to fetch', (value) => parseInt(value, 10));
  program.option('--ignore <slugs>', 'Comma-separated account slugs to leave alone (not evaluated, no action)');
  program.option('--apply', 'Reject the blocked applications (defaults to a dry run - writes to the API)');
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
