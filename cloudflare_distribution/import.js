require('../env');

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const { Command } = require('commander');
const csvParseSync = require('csv-parse/sync'); // eslint-disable-line node/no-missing-require

const { request, gql } = require('graphql-request');
const { pRateLimit } = require('p-ratelimit');

const endpoint = process.env.PERSONAL_TOKEN
  ? `${process.env.API_URL}/graphql?personalToken=${process.env.PERSONAL_TOKEN}`
  : `${process.env.API_URL}/graphql/${process.env.API_KEY}`;

const rateLimiter = pRateLimit({
  interval: 60 * 1000, // 1 minute
  rate: 60, // 60 calls per interval
});

const rateLimitedRequest = (query, variables) => rateLimiter(() => request(endpoint, query, variables));

// Expenses in these states still represent money that is (or will be) on its way to the recipient
const OPEN_EXPENSE_STATUSES = [
  'DRAFT',
  'UNVERIFIED',
  'PENDING',
  'INCOMPLETE',
  'APPROVED',
  'PROCESSING',
  'SCHEDULED_FOR_PAYMENT',
  'PAID',
];

const accountFields = `
  id
  legacyId
  slug
  type
  currency
  isActive
  isArchived
  isFrozen
  ... on AccountWithParent {
    parent {
      slug
    }
  }
  ... on AccountWithHost {
    host {
      id
      slug
      currency
    }
  }
`;

const accountQuery = gql`
  query Account($slug: String!) {
    account(slug: $slug, throwIfMissing: false) {
      ${accountFields}
    }
  }
`;

const fundQuery = gql`
  query Fund($slug: String!) {
    account(slug: $slug, throwIfMissing: false) {
      ${accountFields}
      paymentMethods(type: [COLLECTIVE]) {
        id
        type
        balance {
          valueInCents
          currency
        }
      }
    }
  }
`;

const fundTransactionsQuery = gql`
  query FundTransactions($slug: String!, $dateFrom: DateTime!, $offset: Int!) {
    account(slug: $slug) {
      transactions(type: DEBIT, dateFrom: $dateFrom, limit: 100, offset: $offset) {
        totalCount
        nodes {
          id
          kind
          isRefunded
          oppositeAccount {
            slug
          }
          order {
            legacyId
          }
          expense {
            legacyId
          }
        }
      }
    }
  }
`;

const fundOrdersQuery = gql`
  query FundOrders($slug: String!, $offset: Int!) {
    account(slug: $slug) {
      orders(filter: OUTGOING, frequency: [MONTHLY], status: [ACTIVE, PENDING], limit: 100, offset: $offset) {
        totalCount
        nodes {
          legacyId
          toAccount {
            slug
          }
        }
      }
    }
  }
`;

const fundExpensesQuery = gql`
  query FundExpenses($slug: String!, $offset: Int!) {
    expenses(account: { slug: $slug }, status: ${`[${OPEN_EXPENSE_STATUSES.join(', ')}]`}, limit: 100, offset: $offset) {
      totalCount
      nodes {
        legacyId
        status
        createdAt
        customData
        payee {
          slug
        }
      }
    }
  }
`;

const createOrderMutation = gql`
  mutation CreateOrder($order: OrderCreateInput!) {
    createOrder(order: $order) {
      order {
        legacyId
        status
      }
    }
  }
`;

const inviteMutation = gql`
  mutation InviteExpense(
    $account: AccountReferenceInput!
    $expense: ExpenseInviteDraftInput!
    $lockedFields: [ExpenseLockableFields]
  ) {
    draftExpenseAndInviteUser(account: $account, expense: $expense, lockedFields: $lockedFields) {
      legacyId
      status
    }
  }
`;

// Row ids (R01, R02, ...) are what we print; names and emails never reach the console
const rowId = (index) => `R${String(index + 1).padStart(2, '0')}`;

const parseAmountInCents = (string) => {
  const value = parseFloat(String(string).replace(/[^0-9.]/g, ''));
  return Number.isFinite(value) ? Math.round(value * 100) : null;
};

const parseFrequency = (string) => {
  if (/monthly/i.test(string)) {
    return 'MONTHLY';
  } else if (/one/i.test(string)) {
    return 'ONETIME';
  }
};

// Handles opencollective.com/<slug>, /<parent>/projects/<slug>, /<parent>/events/<slug> and trailing /donate, /contribute...
const parseSlug = (url) => {
  const trimmed = (url || '').trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`);
    if (!/(^|\.)opencollective\.com$/.test(parsed.hostname)) {
      return null;
    }
    const segments = parsed.pathname.split('/').filter(Boolean);
    if (['projects', 'events'].includes(segments[1]) && segments[2]) {
      return segments[2];
    }
    return segments[0] || null;
  } catch {
    return null;
  }
};

const startOfCurrentMonth = () => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
};

const fetchAll = async (query, variables, getPage) => {
  const nodes = [];
  for (let offset = 0; ; offset += 100) {
    const page = getPage(await rateLimitedRequest(query, { ...variables, offset }));
    nodes.push(...page.nodes);
    if (nodes.length >= page.totalCount || page.nodes.length === 0) {
      return nodes;
    }
  }
};

const loadLedger = (ledgerPath) => (fs.existsSync(ledgerPath) ? JSON.parse(fs.readFileSync(ledgerPath, 'utf8')) : {});

const saveLedger = (ledgerPath, ledger) => fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));

const confirm = (question) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    }),
  );
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const formatCents = (cents, currency) => `${(cents / 100).toLocaleString('en-US')} ${currency}`;

// Existing contributions / expenses from the Fund, to avoid paying anyone twice
async function fetchExistingActivity(fundSlug) {
  const dateFrom = startOfCurrentMonth();

  const transactions = await fetchAll(
    fundTransactionsQuery,
    { slug: fundSlug, dateFrom },
    (data) => data.account.transactions,
  );
  const toRef = (t) =>
    t.expense ? { type: 'expense', id: t.expense.legacyId } : t.order ? { type: 'order', id: t.order.legacyId } : null;
  const paidThisMonth = new Map(
    transactions.filter((t) => !t.isRefunded && t.oppositeAccount).map((t) => [t.oppositeAccount.slug, toRef(t)]),
  );

  const orders = await fetchAll(fundOrdersQuery, { slug: fundSlug }, (data) => data.account.orders);
  const recurring = new Map(orders.map((o) => [o.toAccount.slug, o.legacyId]));

  const expenses = await fetchAll(fundExpensesQuery, { slug: fundSlug }, (data) => data.expenses);
  const expensesByKey = new Map();
  const expensesBySlug = new Map();
  const expenseCreatedAt = new Map();
  for (const expense of expenses) {
    expenseCreatedAt.set(expense.legacyId, expense.createdAt);
    // Paid expenses only count if they were created this month, anything still open always counts
    if (expense.status === 'PAID' && expense.createdAt < dateFrom) {
      continue;
    }
    if (expense.customData?.viteFundKey) {
      expensesByKey.set(expense.customData.viteFundKey, expense.legacyId);
    }
    // Expenses created by this script are tracked by row key, so they must not block other rows for the same account
    if (expense.payee?.slug && !expense.customData?.viteFundKey) {
      expensesBySlug.set(expense.payee.slug, expense.legacyId);
    }
  }

  return { paidThisMonth, recurring, expensesByKey, expensesBySlug, expenseCreatedAt };
}

const refFromLedger = (text) => {
  const match = /(order|expense) #(\d+)/.exec(text || '');
  return match ? { type: match[1], id: match[2] } : null;
};

const websiteBase = () => `https://${new URL(process.env.API_URL).host.replace(/^api-/, '').replace(/^api\./, '')}`;

const accountRoute = (account) =>
  account.parent?.slug && ['PROJECT', 'EVENT'].includes(account.type)
    ? `/${account.parent.slug}/${account.type === 'EVENT' ? 'events' : 'projects'}/${account.slug}`
    : `/${account.slug}`;

// Expenses are filed under the Fund, contributions live on the recipient's page
const linkFor = (row, ref, fund) => {
  if (ref?.type === 'expense') {
    return `${websiteBase()}${accountRoute(fund)}/expenses/${ref.id}`;
  } else if (ref?.type === 'order' && row.account) {
    return `${websiteBase()}${accountRoute(row.account)}/contributions/${ref.id}`;
  }
};

const csvField = (value) => (/[",\r\n]/.test(value) ? `"${String(value).replace(/"/g, '""')}"` : String(value));

// Writes a copy of the CSV where Status holds the link to the contribution/expense, the original is left untouched
function writeCsvWithLinks(inputFilename, records, rows, ledger, fund) {
  let updated = 0;
  for (const [index, row] of rows.entries()) {
    const ref = refFromLedger(ledger[row.key]?.done) || row.existingRef;
    const link = linkFor(row, ref, fund);
    if (link) {
      records[index]['Status'] = link;
      updated++;
    }
  }
  const header = Object.keys(records[0]);
  const lines = [header, ...records.map((r) => header.map((column) => r[column]))].map((cells) =>
    cells.map(csvField).join(','),
  );
  const outputFilename = `${inputFilename.replace(/\.csv$/i, '')}.with-links.csv`;
  fs.writeFileSync(outputFilename, `${lines.join('\n')}\n`);
  console.log(`Wrote ${updated} links to ${outputFilename}`);
}

const canReceiveFromFund = (account, fundHostId) =>
  Boolean(account && account.isActive && !account.isArchived && !account.isFrozen && account.host?.id === fundHostId);

// The invite expense previously created for a row, found through the ledger, the link in Status or the Fund's expenses
function findInviteExpense(row, record, ledgerEntry, existing) {
  const fromLedger = refFromLedger(ledgerEntry?.done);
  const fromStatus = /\/expenses\/(\d+)\/?$/.exec(record['Status'].trim());
  const id =
    (fromLedger?.type === 'expense' && fromLedger.id) || fromStatus?.[1] || existing.expensesByKey.get(row.key);
  if (!id) {
    return null;
  }
  const createdAt = existing.expenseCreatedAt.get(Number(id)) || existing.expenseCreatedAt.get(id) || ledgerEntry?.at;
  return { id, createdAt };
}

const normalizeKey = (name) =>
  String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

async function lookupAccount(slug) {
  const data = await rateLimitedRequest(accountQuery, { slug });
  return data.account;
}

async function classify(record, index, { fundHostId, existing, ledger, sharedSlugs }) {
  const id = rowId(index);
  const row = { id, record, amountInCents: parseAmountInCents(record['Amounts']) };
  row.frequency = parseFrequency(record['monthly vs one-time']);
  // One recipient can appear in several rows (e.g. monthly + one-time), so the key includes frequency and amount
  const key = (row.key = [normalizeKey(record['name']), row.frequency, row.amountInCents].join(':'));

  if (!row.amountInCents || !row.frequency) {
    return { ...row, bucket: 'invalid', reason: 'Could not parse amount or frequency' };
  }
  const slug = parseSlug(record['Donation URL']) || parseSlug(record['URLs']);
  row.slug = slug;

  // The account is needed for every row: to classify it, and to build the contribution link for --update-csv
  let account = null;
  let lookupFailed = false;
  if (slug) {
    try {
      account = await lookupAccount(slug);
    } catch (err) {
      lookupFailed = true;
    }
  }
  row.account = account;

  // Follow-up for monthly rows that were handled with an invite expense: once the recipient has an account that can
  // receive balance contributions (the CSV was updated with it), set up the monthly contribution. Not in the same
  // month as the invite, which already covers that month's payment.
  const invite = findInviteExpense(row, record, ledger[key], existing);
  if (
    row.frequency === 'MONTHLY' &&
    invite &&
    canReceiveFromFund(account, fundHostId) &&
    !existing.recurring.has(slug)
  ) {
    if (!invite.createdAt || invite.createdAt >= startOfCurrentMonth()) {
      return {
        ...row,
        bucket: 'already-done',
        reason: `Invite expense #${invite.id} is from this month, monthly contribution can be set up from next month`,
        existingRef: { type: 'expense', id: invite.id },
      };
    }
    return {
      ...row,
      bucket: 'ready',
      reason: `Invite expense #${invite.id} was sent earlier and the account can now receive contributions, setting up the monthly contribution`,
    };
  }

  if (ledger[key]?.done) {
    return { ...row, bucket: 'already-done', reason: `Ledger: ${ledger[key].done}` };
  }
  if (lookupFailed) {
    return { ...row, bucket: 'ambiguous', reason: `Account lookup failed for "${slug}"` };
  }

  // Duplicate checks (done for every row, including the ones marked as Sent, to verify the column).
  // Slug-based checks are not reliable when several rows target the same account, those are flagged for a manual check.
  const useSlugChecks = slug && !sharedSlugs.has(slug);
  const duplicate = [
    existing.expensesByKey.has(key) && [
      `expense #${existing.expensesByKey.get(key)} already created for this row`,
      { type: 'expense', id: existing.expensesByKey.get(key) },
    ],
    useSlugChecks &&
      existing.paidThisMonth.has(slug) && [`Fund already paid ${slug} this month`, existing.paidThisMonth.get(slug)],
    useSlugChecks &&
      existing.recurring.has(slug) && [
        `Active recurring contribution #${existing.recurring.get(slug)} to ${slug}`,
        { type: 'order', id: existing.recurring.get(slug) },
      ],
    useSlugChecks &&
      existing.expensesBySlug.has(slug) && [
        `expense #${existing.expensesBySlug.get(slug)} already open for ${slug}`,
        { type: 'expense', id: existing.expensesBySlug.get(slug) },
      ],
  ].find(Boolean);
  if (duplicate) {
    return { ...row, bucket: 'already-contributed', reason: duplicate[0], existingRef: duplicate[1] };
  }
  // The Status column holds either "Sent" or, once this script has handled a row, a link to the order/expense
  const status = record['Status'].trim();
  if (/^sent$/i.test(status) || /^https?:\/\//i.test(status)) {
    return {
      ...row,
      bucket: 'skipped-sent',
      reason: /^sent$/i.test(status)
        ? 'Status is Sent but no matching activity was found, check manually'
        : 'Status already has a link',
    };
  }

  if (!account) {
    if (!record['contact address']?.trim()) {
      return { ...row, bucket: 'ambiguous', reason: 'No Open Collective account and no contact address' };
    }
    return { ...row, bucket: 'needs-invite', reason: 'No Open Collective account' };
  }
  if (account.isArchived || account.isFrozen) {
    return { ...row, bucket: 'ambiguous', reason: `Account ${account.slug} is archived or frozen` };
  }
  const host = account.host;
  if (host && account.isActive && host.id === fundHostId) {
    return { ...row, bucket: 'ready', reason: 'Same host, can contribute from the Fund balance' };
  }
  // Balance transfers only work inside one host, so everything else goes through an expense on the existing account
  return {
    ...row,
    bucket: 'existing-account-expense',
    reason: host
      ? host.id === fundHostId
        ? 'Account is not active yet'
        : 'Different host than the Fund'
      : 'Account has no host (e.g. individual)',
  };
}

const buildInviteExpense = (row, fund, { recipientNotes, description }) => {
  const recipientNote = recipientNotes[row.frequency].replaceAll(
    '{{amount}}',
    formatCents(row.amountInCents, fund.currency),
  );
  const payee =
    row.bucket === 'existing-account-expense'
      ? { legacyId: row.account.legacyId }
      : {
          name: row.record['name'].trim(),
          email: row.record['contact address'].trim(),
          isInvite: true,
        };
  return {
    description,
    type: 'INVOICE',
    currency: fund.currency,
    items: [{ description, amount: row.amountInCents, incurredAt: new Date().toISOString() }],
    payee,
    recipientNote,
    customData: { viteFundKey: row.key },
    tags: ['vite-ecosystem-fund'],
  };
};

async function execute(row, { fund, fundSlug, paymentMethodId, inviteOptions }) {
  if (row.bucket === 'ready') {
    const { createOrder } = await rateLimitedRequest(createOrderMutation, {
      order: {
        fromAccount: { slug: fundSlug },
        toAccount: { slug: row.slug },
        amount: { valueInCents: row.amountInCents, currency: fund.currency },
        frequency: row.frequency,
        paymentMethod: { id: paymentMethodId },
      },
    });
    return `order #${createOrder.order.legacyId} (${createOrder.order.status})`;
  } else {
    const result = await rateLimitedRequest(inviteMutation, {
      account: { slug: fundSlug },
      expense: buildInviteExpense(row, fund, inviteOptions),
      lockedFields: ['AMOUNT', 'DESCRIPTION'],
    });
    return `expense #${result.draftExpenseAndInviteUser.legacyId} (${result.draftExpenseAndInviteUser.status})`;
  }
}

const printSummary = (rows, fund) => {
  const buckets = new Map();
  for (const row of rows) {
    buckets.set(row.bucket, [...(buckets.get(row.bucket) || []), row]);
  }
  for (const [bucket, bucketRows] of buckets) {
    console.log(`\n== ${bucket} (${bucketRows.length}) ==`);
    for (const row of bucketRows) {
      const amount = row.amountInCents ? formatCents(row.amountInCents, fund.currency) : '?';
      console.log(
        `  ${row.id}  ${amount.padEnd(14)} ${(row.frequency || '?').padEnd(8)} ${row.slug || '-'}  ${row.reason}`,
      );
    }
  }
  return buckets;
};

async function main(argv = process.argv) {
  const program = getProgram(argv);
  const options = program.opts();
  const [inputFilename] = program.args;
  const ledgerPath = path.resolve(options.ledger);

  console.log(`API: ${process.env.API_URL}`);
  if (!options.run) {
    console.log('This is a dry run, run the script with --run to trigger it for real.');
  }

  const records = csvParseSync.parse(fs.readFileSync(inputFilename, 'utf8'), {
    columns: true,
    bom: true,
    skip_empty_lines: true,
  });

  const fundData = await rateLimitedRequest(fundQuery, { slug: options.fund });
  const fund = fundData.account;
  if (!fund?.host) {
    throw new Error(
      `Could not load the Fund "${options.fund}" (or it has no host) on ${process.env.API_URL}. Check API_URL, the Fund only exists on production.`,
    );
  }
  if (fund.currency !== 'USD') {
    throw new Error(`Fund currency is ${fund.currency}, but the CSV amounts are in $`);
  }
  const paymentMethod = fund.paymentMethods?.[0];
  const balance = paymentMethod?.balance?.valueInCents ?? 0;
  console.log(`Fund: ${fund.slug}, host: ${fund.host.slug}, balance: ${formatCents(balance, fund.currency)}`);

  const existing = await fetchExistingActivity(options.fund);
  const ledger = loadLedger(ledgerPath);
  const slugs = records.map((r) => parseSlug(r['Donation URL']) || parseSlug(r['URLs'])).filter(Boolean);
  const sharedSlugs = new Set(slugs.filter((slug, i) => slugs.indexOf(slug) !== i));
  if (sharedSlugs.size > 0) {
    console.warn(
      `Several rows target the same account (${[...sharedSlugs].join(', ')}), check the Fund's activity for them manually.`,
    );
  }
  const context = { fundHostId: fund.host.id, existing, ledger, sharedSlugs };

  const rows = [];
  for (const [index, record] of records.entries()) {
    rows.push(await classify(record, index, context));
  }

  try {
    const buckets = printSummary(rows, fund);

    const toRun = rows.filter((r) => ['ready', 'needs-invite', 'existing-account-expense'].includes(r.bucket));
    const firstPayments = toRun.reduce((sum, r) => sum + r.amountInCents, 0);
    const monthlyTotal = toRun.filter((r) => r.frequency === 'MONTHLY').reduce((sum, r) => sum + r.amountInCents, 0);
    console.log(
      `\nTo process: ${toRun.length} rows, ${formatCents(firstPayments, fund.currency)} in first payments ` +
        `(${formatCents(monthlyTotal, fund.currency)} of it recurs monthly). Fund balance: ${formatCents(balance, fund.currency)}.`,
    );
    if (firstPayments > balance) {
      console.warn('WARNING: first payments exceed the Fund balance, some will fail.');
    }
    console.log(
      `Orders via balance: ${(buckets.get('ready') || []).length}, invite expenses: ${toRun.length - (buckets.get('ready') || []).length}`,
    );

    if (!options.run || toRun.length === 0) {
      return;
    }
    if (!paymentMethod && (buckets.get('ready') || []).length > 0) {
      throw new Error('The Fund has no COLLECTIVE payment method, cannot create contributions');
    }
    if (!options.yes && !(await confirm(`Create ${toRun.length} contributions/invites for real? (y/N) `))) {
      console.log('Aborted.');
      return;
    }

    const inviteOptions = {
      description: options.description,
      recipientNotes: {
        ONETIME: fs.readFileSync(path.join(__dirname, 'invite-note.md'), 'utf8').trim(),
        MONTHLY: fs.readFileSync(path.join(__dirname, 'invite-note-monthly.md'), 'utf8').trim(),
      },
    };
    const delayMs = Number(options.delay) * 1000;
    for (const [index, row] of toRun.entries()) {
      try {
        const result = await execute(row, {
          fund,
          fundSlug: options.fund,
          paymentMethodId: paymentMethod?.id,
          inviteOptions,
        });
        ledger[row.key] = { done: `${row.bucket}: ${result}`, at: new Date().toISOString() };
        saveLedger(ledgerPath, ledger);
        console.log(`${row.id}: ${row.bucket} -> ${result}`);
      } catch (err) {
        const message = err.response?.errors?.[0]?.message || err.message;
        console.error(`${row.id}: FAILED (${row.bucket}): ${message}`);
        if (/rate limit/i.test(message)) {
          console.error(
            'Hit the API rate limit, stopping. Completed rows are saved, rerun later (or with a higher --delay).',
          );
          return;
        }
      }
      // Invites are rate limited by the API, space them out
      if (row.bucket !== 'ready' && index < toRun.length - 1 && delayMs > 0) {
        await sleep(delayMs);
      }
    }
  } finally {
    if (options.updateCsv) {
      writeCsvWithLinks(inputFilename, records, rows, ledger, fund);
    }
  }
}

const getProgram = (argv) => {
  const program = new Command();
  program.exitOverride();
  program.showSuggestionAfterError();

  program.argument('<string>', 'Path to the CSV file to parse.');

  program.option('--run', 'Create contributions and invites for real.');
  program.option('--yes', 'Skip the confirmation prompt when used with --run.');
  program.option('--fund <slug>', 'Slug of the Fund making the contributions.', 'vite-ecosystem-fund');
  program.option('--ledger <path>', 'Where completed rows are recorded.', path.join(__dirname, 'results.json'));
  program.option(
    '--update-csv',
    'Write a copy of the CSV with links to the contributions/expenses in the Status column.',
  );
  program.option('--delay <seconds>', 'Seconds to wait after each invite expense.', '20');
  program.option('--description <description>', 'Description for invite expenses.', 'Vite Ecosystem Fund contribution');

  program.parse(argv);

  return program;
};

if (!module.parent) {
  main()
    .then(() => process.exit())
    .catch((e) => {
      if (e.name !== 'CommanderError') {
        console.error(e.response?.errors?.[0]?.message || e);
      }

      process.exit(1);
    });
}
