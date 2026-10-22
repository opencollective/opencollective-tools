/**
 * Eligibility rules for OSC host applications, for the review tooling.
 *
 * This is the review-script mirror of the applicant-facing rules in
 * `opencollective-frontend/components/osc-host-application/applicationRules.ts`: same rule ids,
 * thresholds, severities, mitigations and combination handling, so the triage this script
 * produces matches what the application form shows. Keep the two in sync - the intended
 * differences are the i18n messages (replaced by the `RULE_MESSAGES` strings here), the repository
 * input
 * (`toRepositorySnapshot` projects the `RepoInfo` shape of `lib/ecosyste.ms.ts` into the same
 * snapshot the frontend evaluates, which it stores as `applicationData.ecosystemsRepositoryInfo`),
 * and `getRuleMetrics`, which exposes the properties the rules branch on for the triage output.
 *
 * Rule evidence and thresholds are calibrated on `OSC Host Application Review - October 2026.csv`
 * (see `application_rules.md` in the maintain-osc-host-application worktree).
 */

import spdxLicenses from 'spdx-license-list';

import type { RepoInfo } from '../lib/ecosyste.ms.ts';

// ─── Repository snapshot ─────────────────────────────────────────────────────

/** Same projection as `EcosystemsRepositorySnapshot` in the frontend */
export type RepositorySnapshot = {
  fullName: string | null;
  owner: string | null;
  /** Owner kind as reported by ecosyste.ms (`user` for personal accounts, `organization`) */
  ownerKind: string | null;
  description: string | null;
  stars: number | null;
  forks: number | null;
  isFork: boolean | null;
  license: string | null;
  /** Repository topics (e.g. GitHub topics) */
  topics: string[];
  archived: boolean | null;
  /** Repository creation date */
  createdAt: string | null;
  /** Date of the last commit/push activity */
  lastCommitAt: string | null;
  lastCommitSha: string | null;
  commitStats: {
    totalCommits: number;
    /** Human committers only, bot accounts are reported separately */
    totalCommitters: number;
    /** Bot committers reported by the commits API, when available */
    botCommitters?: number;
  } | null;
  packages: Array<{
    name: string;
    ecosystem: string;
    maintainers: Array<{ login: string | null; name: string | null }>;
    /** Number of packages depending on this package */
    dependentPackagesCount: number | null;
    /** Number of repositories depending on this package */
    dependentReposCount: number | null;
    firstReleasePublishedAt: string | null;
    latestReleasePublishedAt: string | null;
  }>;
};

/** Human committers across every ecosyste.ms source of the lookup (the repository record, the
 * package metadata and the commits API, minus the bots it reports separately). The review
 * sheet's `contributors` column was built on this maximum - the frontend snapshot can only see
 * `commit_stats`, so its own projection is a subset of this. */
function maxHumanCommitters(entry: RepoInfo): number | null {
  const counts = [entry.repository?.commit_stats?.total_committers];

  for (const pkg of entry.packages || []) {
    counts.push(pkg.repo_metadata?.commit_stats?.total_committers);
  }

  if (entry.contributors) {
    if (typeof entry.contributors.total_committers === 'number') {
      counts.push(entry.contributors.total_committers - (entry.contributors.total_bot_committers || 0));
    }
    if (typeof entry.contributors.past_year_total_committers === 'number') {
      counts.push(
        entry.contributors.past_year_total_committers - (entry.contributors.past_year_total_bot_committers || 0),
      );
    }
  }

  const valid = counts.filter((count): count is number => typeof count === 'number');
  return valid.length > 0 ? Math.max(...valid) : null;
}

/** Projects a `RepoInfo` (ecosyste.ms lookup) into the snapshot the rules evaluate */
export function toRepositorySnapshot(entry: RepoInfo): RepositorySnapshot {
  const repository = entry.repository;
  const totalCommitters = maxHumanCommitters(entry);
  const botCommitters = entry.contributors?.total_bot_committers;
  const hasCommitStats = totalCommitters !== null || typeof botCommitters === 'number';
  return {
    fullName: repository?.full_name ?? null,
    owner: repository?.owner ?? null,
    ownerKind: entry.owner?.kind ?? null,
    description: repository?.description ?? null,
    stars: repository?.stargazers_count ?? null,
    forks: repository?.forks_count ?? null,
    isFork: repository?.fork ?? null,
    license: repository?.license ?? null,
    topics: repository?.topics ?? [],
    archived: repository?.archived ?? null,
    createdAt: repository?.created_at ?? null,
    lastCommitAt: repository?.pushed_at ?? null,
    lastCommitSha: repository?.commit_stats?.last_synced_commit ?? null,
    commitStats: hasCommitStats
      ? {
          totalCommits: repository?.commit_stats?.total_commits ?? 0,
          totalCommitters: totalCommitters ?? 0,
          ...(typeof botCommitters === 'number' && { botCommitters }),
        }
      : null,
    packages: (entry.packages || []).map((pkg) => ({
      name: pkg.name,
      ecosystem: pkg.ecosystem,
      maintainers: (pkg.maintainers || []).map((maintainer) => ({
        login: maintainer.login ?? null,
        name: maintainer.name ?? null,
      })),
      dependentPackagesCount: pkg.dependent_packages_count ?? null,
      dependentReposCount: pkg.dependent_repos_count ?? null,
      firstReleasePublishedAt: pkg.first_release_published_at ?? null,
      latestReleasePublishedAt: pkg.latest_release_published_at ?? null,
    })),
  };
}

// ─── Facts ───────────────────────────────────────────────────────────────────

/** State of the ecosyste.ms lookup for the repository URL of the application */
export type RepositoryInfoState =
  /** No (or invalid) repository URL */
  | 'idle'
  /** Fetching (debounce in progress or request in flight) */
  | 'pending'
  /** A repository record was found */
  | 'found'
  /** The lookup succeeded but returned no repository record */
  | 'not-found'
  /** The lookup failed (network, rate limit...) */
  | 'error';

export type ApplicationFacts = {
  typeOfProject?: string | null;
  repositoryUrl?: string | null;
  /** Collective name (used by the keyword rules) */
  name?: string | null;
  message?: string | null;
  description?: string | null;
  /** 1 + invited admins */
  teamSize?: number | null;
  /** False while the applicant has not engaged with the application text (or attempted to submit) */
  applicationTextEngaged?: boolean;
  repositoryInfoState: RepositoryInfoState;
  /** The compact ecosyste.ms snapshot fetched for the repository URL, if any */
  repository?: RepositorySnapshot | null;
};

// ─── Flags ───────────────────────────────────────────────────────────────────

export type RuleId =
  | 'invalid-repository-url'
  | 'repository-not-found'
  | 'no-community'
  | 'personal-account'
  | 'early-stage-personal-account'
  | 'empty-application'
  | 'personal-account-convert'
  | 'early-stage'
  | 'small-community'
  | 'inactive'
  | 'single-admin'
  | 'thin-application'
  | 'events'
  | 'copyright'
  | 'license'
  | 'archived'
  | 'fork'
  | 'unverified-repository';

export type RuleSeverity = 'error' | 'warning' | 'info';

/** The form field a rule relates to: warnings are displayed next to it */
export type RuleField = 'repositoryUrl' | 'licenseSpdxId' | 'typeOfProject' | 'message' | 'team';

const RULE_FIELDS: Record<RuleId, RuleField> = {
  'invalid-repository-url': 'repositoryUrl',
  'repository-not-found': 'repositoryUrl',
  'no-community': 'repositoryUrl',
  'personal-account': 'repositoryUrl',
  'early-stage-personal-account': 'repositoryUrl',
  'empty-application': 'message',
  'personal-account-convert': 'repositoryUrl',
  'early-stage': 'message',
  'small-community': 'message',
  inactive: 'repositoryUrl',
  'single-admin': 'team',
  'thin-application': 'message',
  events: 'typeOfProject',
  copyright: 'message',
  license: 'licenseSpdxId',
  archived: 'repositoryUrl',
  fork: 'repositoryUrl',
  'unverified-repository': 'repositoryUrl',
};

export type RuleFlag = {
  id: RuleId;
  severity: RuleSeverity;
  /** The form field the rule relates to, so warnings can be displayed next to it */
  field?: RuleField;
  /** Warnings that require an explicit confirmation before submitting */
  requiresConfirmation?: boolean;
};

export type SubmissionGate = {
  canSubmit: boolean;
  /** Errors block submission */
  hardBlocks: RuleId[];
  /** Rules waiting for their confirmation checkbox */
  needsConfirmation: RuleId[];
};

export const RULES_CONFIG = {
  /** Below this, the application text counts as empty */
  MESSAGE_EMPTY_LENGTH: 20,
  /** Below this, the application text counts as thin */
  MESSAGE_THIN_LENGTH: 100,
  /** From this, the application text counts as substantial (mitigation input) */
  MESSAGE_SUBSTANTIAL_LENGTH: 200,
  /** Projects younger than this are "early stage" */
  EARLY_STAGE_MONTHS: 3,
  /** Without activity for this long, a repository is inactive */
  INACTIVE_MONTHS: 3,
  /** From this usage level, mature-but-quiet projects are not flagged as inactive */
  STRONG_USAGE: 25,
} as const;

/** Lower-cased keywords that call for the copyrighted-material guarantee before approval */
export const COPYRIGHT_KEYWORDS = [
  'iptv',
  'm3u',
  'torrent',
  'anime',
  'manga',
  'netflix',
  'spotify',
  'crunchyroll',
  'free movies',
  'watch movies',
  'watch series',
  'movie streaming',
  'live tv',
  'live sports',
  'ppv',
  'drm',
  'piracy',
  'cracked',
  'kodi',
  'stremio',
  'emby',
  'jellyfin',
  'usenet',
  'nzb',
];

/** Lower-cased keywords for projects that host in-person events */
export const EVENT_KEYWORDS = [
  'conference',
  'conferences',
  'meetup',
  'meetups',
  'summit',
  'hackathon',
  'workshop',
  'in-person',
];

// ─── Applicant messages ──────────────────────────────────────────────────────

/**
 * The message we would send the applicant for each rule: plain text with `\n` line breaks, the
 * same convention as the dashboard rejection modal (the email renders it in a `white-space:
 * pre-line` blockquote). Blocking errors use the canned templates from `email_templates.md`
 * verbatim with the URLs flattened; the other rules keep the form texts and are never sent.
 * Mapping: `no-community` + `early-stage` -> "Early stage/very new";
 * `early-stage-personal-account` -> "Early Stage + Personal Account"; `personal-account` ->
 * "User-owner profile/not org"; `inactive` + `archived` -> "Inactive"; `empty-application` ->
 * "We don't have enough info to accept".
 */
const messageText = (...paragraphs: string[]) => paragraphs.join('\n\n');

/** no-community / early-stage template */
const EARLY_STAGE_MESSAGE = messageText(
  'Thank you for your interest in fiscal hosting with Open Source Collective.',
  'We’re not able to accept your project at this time. OSC’s fiscal hosting program is designed for community-driven projects with active collaboration, and your project appears to still be in earlier stages or without the level of community involvement needed.',
  'New/early staged projects or projects without community contribution often discover that fiscal hosting adds more administrative overhead than needed at this stage. Platforms like Ko-Fi, Patreon, or Buy Me a Coffee are often a better fit for now.',
  'As your project grows and more contributors get involved, you’re welcome to reapply. You can learn more about our criteria here: https://docs.oscollective.org/interested-in-joining-osc/is-osc-right-for-me',
  'If you have any questions, feel free to reach out at hello@oscollective.org.',
);

/** early-stage-personal-account template */
const COMBO_MESSAGE = messageText(
  'Thank you for your interest in fiscal hosting with Open Source Collective.',
  'We’re not able to accept your project at this time. OSC’s fiscal hosting program is designed for community-driven projects with active collaboration, and your project appears to still be in earlier stages or without the level of community involvement needed. Additionally, we noticed your project currently hosted under a personal GitHub user-owner profile. We only accept projects hosted under a GitHub organization account, as this better reflects the community-driven structure we support.',
  'New/early staged projects or projects without community contribution often discover that fiscal hosting adds more administrative overhead than needed at this stage. Platforms like Ko-Fi, Patreon, or Buy Me a Coffee are often a better fit for now.',
  'As your project grows and more contributors get involved, you’re welcome to reapply. You can learn more about our criteria here: https://docs.oscollective.org/interested-in-joining-osc/is-osc-right-for-me',
  'If you have any questions, feel free to reach out at hello@oscollective.org.',
);

/** personal-account template */
const PERSONAL_ACCOUNT_MESSAGE = messageText(
  'Thank you for your interest in having OSC serve as your project’s fiscal host.',
  'At this time, we can’t accept the project because it’s currently hosted under a personal GitHub user-owner profile. We only accept projects hosted under a GitHub organization account, as this better reflects the community-driven structure we support.',
  'You can read more about our eligibility requirements here:https://docs.oscollective.org/interested-in-joining-osc/is-osc-right-for-me',
  'If you’re open to transferring your project to a GitHub organization in the future, you’re welcome to apply again. Please note that while this is a required step, it doesn’t guarantee acceptance; all applications are reviewed against our full criteria.',
  `GitHub resources:
  • Types of GitHub accounts: https://docs.github.com/en/get-started/learning-about-github/types-of-github-accounts
  • Converting a user profile into an organization: https://docs.github.com/en/account-and-profile/setting-up-and-managing-your-personal-account-on-github/managing-your-personal-account/converting-a-user-into-an-organization`,
  'If you have questions, feel free to reach out to hello@oscollective.org.',
);

/** inactive / archived template */
const INACTIVE_MESSAGE = messageText(
  "Thank you for your interest in Open Source Collective's fiscal hosting program.",
  'At this time, we aren’t able to accept your application because the project hasn’t shown recent activity on your linked repository.',
  'Our fiscal hosting is designed for projects that are currently active or have a significant level of ongoing usage, as this helps us ensure we can provide the right kind of support.',
  'You can read more about our eligibility criteria here: https://docs.oscollective.org/getting-started/acceptance-criteria',
  'We’d love to see your project continue to grow, and we welcome you to apply again in the future once there’s more activity.',
  'If you have any questions, please feel free to reach out at hello@oscollective.org',
);

/** empty-application template */
const EMPTY_APPLICATION_MESSAGE = messageText(
  'Thank you for your interest in fiscal hosting with Open Source Collective.',
  "Unfortunately, we can't accept your project at this time, as we don’t have enough information to determine if it’s a good fit.",
  'You can review our eligibility criteria here: https://docs.oscollective.org/interested-in-joining-osc/acceptance-criteria.',
  'If you believe you meet the requirements, we welcome you to reapply with more details and relevant links.',
);

export const RULE_MESSAGES: Record<RuleId, string> = {
  'invalid-repository-url':
    'Please link directly to your source code repository (for example https://github.com/your-org/your-repository).',
  'repository-not-found': "We couldn't find this repository. It must exist and be public for us to review it.",
  'no-community': EARLY_STAGE_MESSAGE,
  'personal-account': PERSONAL_ACCOUNT_MESSAGE,
  'early-stage-personal-account': COMBO_MESSAGE,
  'empty-application': EMPTY_APPLICATION_MESSAGE,
  'personal-account-convert':
    'Your project is hosted under a personal account. We only accept projects under organizational accounts.',
  'early-stage': EARLY_STAGE_MESSAGE,
  'small-community':
    'Your project shows a small community or limited usage so far. Tell us about your contributors and users in your application message.',
  inactive: INACTIVE_MESSAGE,
  'single-admin':
    'We recommend adding at least one more admin to your Collective: shared responsibility is part of what we look for.',
  'thin-application':
    'Please tell us more about your project below: we need enough information to determine whether it is a good fit.',
  events:
    'Projects that host in-person events must have a code of conduct they can consistently implement. Note that we do not provide event insurance as part of our program.',
  copyright:
    'If your project provides access to resources that may be copyrighted, we need a guarantee that it does not and will not provide direct access to copyrighted material without the express permission of the copyright holder. Note that this does not stop you from building tooling that provides access to resources that are user inputted into the application.',
  license:
    "We couldn't find a recognized open source license for this repository. Open source projects must be published under an open source license.",
  archived: INACTIVE_MESSAGE,
  fork: 'This repository is a fork of another project: tell us what is different about yours and who is behind it.',
  'unverified-repository':
    "We couldn't fetch information about this repository automatically. Our team will review it manually.",
};

// ─── Derived metrics ─────────────────────────────────────────────────────────

/** Human contributors: the largest of the committer and package-maintainer counts */
export function getContributors(repository?: RepositorySnapshot | null): number | null {
  const counts = [
    repository?.commitStats?.totalCommitters,
    ...(repository?.packages || []).map((pkg) => pkg.maintainers.length),
  ].filter((count): count is number => typeof count === 'number');
  return counts.length > 0 ? Math.max(...counts) : null;
}

/** Traction: the largest of forks and the package dependent counts */
export function getUsage(repository?: RepositorySnapshot | null): number | null {
  if (!repository) {
    return null;
  }
  const counts = [];
  if (typeof repository.forks === 'number') {
    counts.push(repository.forks);
  }
  if (repository.packages.length > 0) {
    counts.push(repository.packages.reduce((sum, pkg) => sum + (pkg.dependentReposCount || 0), 0));
    counts.push(repository.packages.reduce((sum, pkg) => sum + (pkg.dependentPackagesCount || 0), 0));
  }
  return counts.length > 0 ? Math.max(...counts) : null;
}

/** Project age in months, from the oldest of the repository creation and the first package release */
export function getProjectAgeInMonths(repository?: RepositorySnapshot | null, now: number = Date.now()): number | null {
  const timestamps = [repository?.createdAt, ...(repository?.packages || []).map((pkg) => pkg.firstReleasePublishedAt)]
    .map((value) => (value ? new Date(value).getTime() : NaN))
    .filter((time) => !isNaN(time));
  if (timestamps.length === 0) {
    return null;
  }
  return Math.round(((now - Math.min(...timestamps)) / (30 * 24 * 60 * 60 * 1000)) * 10) / 10;
}

// ─── URL and license helpers ─────────────────────────────────────────────────

const KNOWN_GIT_HOSTS = ['github.com', 'gitlab.com', 'bitbucket.org', 'codeberg.org', 'gitea.com'];

function parseUrl(url?: string | null): URL | null {
  try {
    const parsed = new URL((url || '').trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed : null;
  } catch {
    return null;
  }
}

/** True when the URL points at a repository (host + owner + repository path) */
export function isRepositoryUrl(url?: string | null): boolean {
  const parsed = parseUrl(url);
  if (!parsed) {
    return false;
  }
  return parsed.pathname.split('/').filter(Boolean).length >= 2;
}

/** True for the git hosts ecosyste.ms can look up (self-hosted forges cannot be verified) */
export function isKnownGitHost(url?: string | null): boolean {
  const parsed = parseUrl(url);
  return Boolean(parsed && KNOWN_GIT_HOSTS.includes(parsed.host.replace(/^www\./, '').toLowerCase()));
}

const SPDX_LICENSE_ID_BY_LOWER_ID = Object.fromEntries(Object.keys(spdxLicenses).map((id) => [id.toLowerCase(), id]));

/** Maps the license identifier reported by the repository host (e.g. `mit`) to its SPDX id (e.g. `MIT`) */
export function toSpdxLicenseId(license?: string | null): string | null {
  return SPDX_LICENSE_ID_BY_LOWER_ID[(license || '').trim().toLowerCase()] || null;
}

/** True when the repository license is a recognized (OSI approved) open source license */
export function isOpenSourceLicense(license?: string | null): boolean {
  const spdxId = toSpdxLicenseId(license);
  return Boolean(spdxId && spdxLicenses[spdxId]?.osiApproved);
}

// ─── Rules ───────────────────────────────────────────────────────────────────

const containsKeyword = (text: string, keywords: string[]): boolean => {
  const lowerCased = text.toLowerCase();
  return keywords.some((keyword) => lowerCased.includes(keyword));
};

/** The properties `evaluateApplication` branches on - exposed so the triage output can show its work */
export type RuleMetrics = {
  repositoryInfoState: RepositoryInfoState;
  typeOfProject: string | null;
  /** Message length the text rules use */
  messageLength: number;
  hasDescription: boolean;
  applicationTextEngaged: boolean;
  teamSize: number;
  /** Human contributors the rules use (null = unknown) */
  contributors: number | null;
  /** Traction the rules use: max(forks, package dependent sums) (null = unknown) */
  usage: number | null;
  /** Project age in months from the oldest known timestamp (null = unknown) */
  ageInMonths: number | null;
  /** Months since the last commit/push (null = unknown) */
  monthsSinceLastCommit: number | null;
  ownerKind: string | null;
  license: string | null;
  topics: string[];
  isFork: boolean | null;
  archived: boolean | null;
  /** `contributors <= 1 || usage == 0` */
  noCommunity: boolean;
  /** `contributors <= 2 || usage <= 1` */
  weak: boolean;
  onPersonalAccount: boolean;
  /** `teamSize >= 2 && message >= 200` chars (the "pending second admin" case) */
  communityMitigated: boolean;
  /** The snapshot the repository-derived rules read (null unless the repository was found) */
  repository: RepositorySnapshot | null;
};

/** Computes every property the rules use for a given application */
export function getRuleMetrics(facts: ApplicationFacts): RuleMetrics {
  const message = (facts.message || '').trim();
  const description = (facts.description || '').trim();
  const teamSize = Math.max(1, facts.teamSize ?? 1);
  const repositoryInfoState = facts.repositoryInfoState;
  // Repository-derived rules only run on a repository we actually found: a lookup gap is
  // never evidence against the project (and never blocks)
  const repository = repositoryInfoState === 'found' ? (facts.repository ?? null) : null;

  const contributors = repository ? getContributors(repository) : null;
  const usage = repository ? getUsage(repository) : null;
  const ageInMonths = repository ? getProjectAgeInMonths(repository) : null;
  const monthsSinceLastCommit = repository?.lastCommitAt
    ? (Date.now() - Date.parse(repository.lastCommitAt)) / (30 * 24 * 60 * 60 * 1000)
    : NaN;

  return {
    repositoryInfoState,
    typeOfProject: facts.typeOfProject ?? null,
    messageLength: message.length,
    hasDescription: description.length > 0,
    applicationTextEngaged: Boolean(facts.applicationTextEngaged),
    teamSize,
    contributors,
    usage,
    ageInMonths,
    monthsSinceLastCommit: isNaN(monthsSinceLastCommit) ? null : monthsSinceLastCommit,
    ownerKind: repository?.ownerKind ?? null,
    license: repository?.license ?? null,
    topics: repository?.topics ?? [],
    isFork: repository?.isFork ?? null,
    archived: repository?.archived ?? null,
    noCommunity: (contributors !== null && contributors <= 1) || (usage !== null && usage === 0),
    weak: (contributors !== null && contributors <= 2) || (usage !== null && usage <= 1),
    onPersonalAccount: repository?.ownerKind === 'user',
    communityMitigated: teamSize >= 2 && message.length >= RULES_CONFIG.MESSAGE_SUBSTANTIAL_LENGTH,
    repository,
  };
}

/**
 * Evaluates the application against all rules. Returns the flags to display - empty
 * when the application raises no issue.
 */
export function evaluateApplication(facts: ApplicationFacts): RuleFlag[] {
  const flags: RuleFlag[] = [];
  const url = (facts.repositoryUrl || '').trim();
  const name = facts.name || '';
  const message = facts.message || '';
  const {
    repository,
    repositoryInfoState: state,
    messageLength,
    hasDescription,
    applicationTextEngaged,
    teamSize,
    contributors,
    usage,
    ageInMonths,
    monthsSinceLastCommit,
    noCommunity,
    weak,
    onPersonalAccount,
    communityMitigated,
  } = getRuleMetrics(facts);

  // Repository URL shape (typed URLs only: broken URLs are caught by the field validation).
  // Repository availability is never blocking: we warn and let the reviewers follow up.
  if (facts.typeOfProject === 'CODE' && parseUrl(url) && !isRepositoryUrl(url)) {
    flags.push({ id: 'invalid-repository-url', severity: 'warning' });
  }

  // Repository lookup results
  if (state === 'not-found') {
    if (isKnownGitHost(url)) {
      flags.push({ id: 'repository-not-found', severity: 'warning' });
    } else {
      flags.push({ id: 'unverified-repository', severity: 'info' });
    }
  } else if (state === 'error') {
    flags.push({ id: 'unverified-repository', severity: 'info' });
  }

  // Application text (only once the applicant engaged with it, to avoid scolding an empty form)
  if (applicationTextEngaged) {
    if (!hasDescription && messageLength < RULES_CONFIG.MESSAGE_EMPTY_LENGTH) {
      flags.push({ id: 'empty-application', severity: 'error' });
    } else if (messageLength < RULES_CONFIG.MESSAGE_THIN_LENGTH) {
      flags.push({ id: 'thin-application', severity: 'warning' });
    }
  }

  // Community and traction
  if (noCommunity && onPersonalAccount && weak && !communityMitigated) {
    flags.push({ id: 'early-stage-personal-account', severity: 'error' });
  } else {
    if (noCommunity) {
      flags.push(
        communityMitigated ? { id: 'no-community', severity: 'warning' } : { id: 'no-community', severity: 'error' },
      );
    }
    if (onPersonalAccount && weak) {
      flags.push({ id: 'personal-account', severity: 'error' });
    } else if (onPersonalAccount) {
      flags.push({ id: 'personal-account-convert', severity: 'warning' });
    }
    if (!noCommunity && ((contributors !== null && contributors <= 4) || (usage !== null && usage <= 4))) {
      flags.push({ id: 'small-community', severity: 'warning' });
    }
  }

  if (ageInMonths !== null && ageInMonths < RULES_CONFIG.EARLY_STAGE_MONTHS && weak) {
    flags.push({ id: 'early-stage', severity: 'error' });
  } else if (ageInMonths !== null && ageInMonths < RULES_CONFIG.EARLY_STAGE_MONTHS) {
    flags.push({ id: 'early-stage', severity: 'warning' });
  }

  if (teamSize <= 1) {
    flags.push({ id: 'single-admin', severity: 'warning' });
  }

  const stronglyUsed = usage !== null && usage >= RULES_CONFIG.STRONG_USAGE;
  if (monthsSinceLastCommit !== null && monthsSinceLastCommit > RULES_CONFIG.INACTIVE_MONTHS && !stronglyUsed) {
    flags.push({ id: 'inactive', severity: 'error' });
  }

  const keywordText = `${name} ${message} ${(repository?.topics || []).join(' ')}`;
  if (containsKeyword(keywordText, COPYRIGHT_KEYWORDS)) {
    flags.push({ id: 'copyright', severity: 'warning', requiresConfirmation: true });
  }

  if (facts.typeOfProject === 'COMMUNITY' || containsKeyword(`${name} ${message}`, EVENT_KEYWORDS)) {
    flags.push({ id: 'events', severity: 'warning' });
  }

  if (repository && !isOpenSourceLicense(repository.license)) {
    flags.push({ id: 'license', severity: 'warning' });
  }

  if (repository?.archived) {
    flags.push({ id: 'archived', severity: 'error' });
  }

  if (repository?.isFork) {
    flags.push({ id: 'fork', severity: 'warning' });
  }

  return flags.map((flag) => ({ ...flag, field: RULE_FIELDS[flag.id] }));
}

/**
 * Aggregates the flags into a submission gate: errors block submission, confirmations block
 * until ticked. (The "submit for manual review anyway" escape hatch was removed for now.)
 */
export function getSubmissionGate(
  flags: RuleFlag[],
  { confirmedRuleIds = [] }: { confirmedRuleIds?: string[] } = {},
): SubmissionGate {
  const hardBlocks = flags.filter((flag) => flag.severity === 'error').map((flag) => flag.id);
  const needsConfirmation = flags
    .filter((flag) => flag.requiresConfirmation && !confirmedRuleIds.includes(flag.id))
    .map((flag) => flag.id);

  return {
    canSubmit: hardBlocks.length === 0 && needsConfirmation.length === 0,
    hardBlocks,
    needsConfirmation,
  };
}

/** The flags of a severity, for triage output */
export function flagsBySeverity(flags: RuleFlag[], severity: RuleSeverity): RuleFlag[] {
  return flags.filter((flag) => flag.severity === severity);
}

/**
 * Priority used to pick the error that gets passed down to the rejection. The combined
 * template wins (it already covers the personal-account + community case), then the org
 * requirement, then the community/traction family, then activity and text issues - i.e. the
 * most specific reason we would cite first.
 */
const ERROR_PRIORITY: RuleId[] = [
  'early-stage-personal-account',
  'personal-account',
  'no-community',
  'early-stage',
  'inactive',
  'archived',
  'empty-application',
];

/** The single error to pass down to the application rejection (null when the application is not blocked) */
export function pickPrimaryError(flags: RuleFlag[]): RuleFlag | null {
  const errors = flagsBySeverity(flags, 'error');
  for (const id of ERROR_PRIORITY) {
    const flag = errors.find((error) => error.id === id);
    if (flag) {
      return flag;
    }
  }
  return errors[0] ?? null;
}
