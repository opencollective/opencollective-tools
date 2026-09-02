require('../env');

const readline = require('readline');

const { Command } = require('commander');
const { request, gql } = require('graphql-request');

const endpoint = process.env.PERSONAL_TOKEN
  ? `${process.env.API_URL}/graphql?personalToken=${process.env.PERSONAL_TOKEN}`
  : `${process.env.API_URL}/graphql/${process.env.API_KEY}`;

const accountQuery = gql`
  query Account($slug: String) {
    account(slug: $slug) {
      id
      legacyId
      type
      slug
      name
      updates(limit: 3) {
        nodes {
          title
        }
      }
    }
  }
`;

const banAccountsMutation = gql`
  mutation BanAccounts($account: [AccountReferenceInput!]!, $dryRun: Boolean!, $includeAssociatedAccounts: Boolean!) {
    banAccount(account: $account, includeAssociatedAccounts: $includeAssociatedAccounts, dryRun: $dryRun) {
      isAllowed
      message
      accounts {
        id
        slug
        name
        type
        ... on AccountWithParent {
          parent {
            id
            slug
            type
          }
        }
      }
    }
  }
`;

const catchException = (e) => {
  if (e.response?.errors) {
    console.error('GraphQL Error:', e.response.errors.map((err) => err.message).join(', '));
  } else {
    console.error('Error:', e.message || e);
  }
  return null;
};

function confirm(message) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(`${message} (Y/n) `, (answer) => {
      rl.close();
      const normalized = answer.toLowerCase().trim();
      resolve(normalized === '' || normalized === 'y' || normalized === 'yes');
    });
  });
}

async function fetchAccountWithSlug(slug) {
  const data = await request(endpoint, accountQuery, { slug }).catch(catchException);
  return data?.account;
}

async function banAccount(account, includeAssociatedAccounts, dryRun) {
  const variables = {
    account: [{ slug: account.slug }],
    includeAssociatedAccounts,
    dryRun,
  };
  const data = await request(endpoint, banAccountsMutation, variables).catch(catchException);
  return data?.banAccount;
}

function displayBanSummary(result, account) {
  console.log('\nBan accounts\n');
  console.log(`URL: https://opencollective.com/${account.slug}`);
  if (account.updates?.nodes?.length) {
    console.log('Latest updates:');
    for (const update of account.updates.nodes) {
      console.log(`  - ${update.title}`);
    }
  }
  if (result.message) {
    console.log(result.message);
  }
  if (result.accounts.length) {
    const accountSlugs = result.accounts.map((a) => a.slug).join(', ');
    console.log(`List of impacted accounts: ${accountSlugs}`);
  }
  console.log('');
}

async function processAccount(slug, options) {
  console.log(`\nProcessing account: ${slug}`);

  const account = await fetchAccountWithSlug(slug);
  if (!account) {
    console.error(`Account not found: ${slug}`);
    return { success: false, slug, reason: 'not found' };
  }

  console.log(`Found account: ${account.name} (${account.slug}, ${account.type})`);

  // First, do a dry run to analyze
  console.log('\nAnalyzing...');
  const dryRunResult = await banAccount(account, options.includeAssociated, true);

  if (!dryRunResult) {
    console.error(`Failed to analyze account: ${slug}`);
    return { success: false, slug, reason: 'analysis failed' };
  }

  displayBanSummary(dryRunResult, account);

  if (!dryRunResult.isAllowed) {
    console.error(`Banning not allowed for account: ${slug}`);
    return { success: false, slug, reason: 'not allowed' };
  }

  // Ask for confirmation
  const confirmed = await confirm(`Do you want to ban ${dryRunResult.accounts.length} account(s)?`);

  if (!confirmed) {
    console.log(`Skipped banning account: ${slug}`);
    return { success: false, slug, reason: 'user cancelled' };
  }

  // Execute the actual ban
  console.log(`Banning account: ${slug}...`);
  const banResult = await banAccount(account, options.includeAssociated, false);

  if (!banResult) {
    console.error(`Failed to ban account: ${slug}`);
    return { success: false, slug, reason: 'ban failed' };
  }

  console.log(`Successfully banned ${banResult.accounts.length} account(s) for: ${slug}`);
  if (banResult.message) {
    console.log(`Result: ${banResult.message}`);
  }

  return { success: true, slug, bannedCount: banResult.accounts.length };
}

async function main(argv = process.argv) {
  const program = getProgram(argv);
  const options = program.opts();
  const slugs = program.args;

  if (slugs.length === 0) {
    console.error('Please provide at least one account slug');
    process.exit(1);
  }

  console.log(`Processing ${slugs.length} account(s)...`);
  console.log(`Include associated accounts: ${options.includeAssociated ? 'Yes' : 'No'}`);

  const results = [];
  for (const slug of slugs) {
    const result = await processAccount(slug, options);
    results.push(result);
  }

  // Summary
  console.log('\n=== Final Summary ===');
  const successful = results.filter((r) => r.success);
  const failed = results.filter((r) => !r.success);

  if (successful.length > 0) {
    console.log(`Successfully banned: ${successful.map((r) => r.slug).join(', ')}`);
  }
  if (failed.length > 0) {
    console.log(`Failed/Skipped: ${failed.map((r) => `${r.slug} (${r.reason})`).join(', ')}`);
  }
  console.log('=====================\n');
}

const getProgram = (argv) => {
  const program = new Command();
  program.exitOverride();
  program.showSuggestionAfterError();

  program.name('ban-accounts');
  program.description('Ban one or more accounts from Open Collective');
  program.argument('<slugs...>', 'The slug(s) of the Account(s) to ban');

  program.option('--no-include-associated', 'Do not include associated accounts');

  program.parse(argv);

  return program;
};

if (!module.parent) {
  main()
    .then(() => process.exit())
    .catch((e) => {
      if (e.name !== 'CommanderError') {
        console.error(e);
      }
      process.exit(1);
    });
}
