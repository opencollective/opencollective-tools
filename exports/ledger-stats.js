require('../env');

const { Command } = require('commander');
const fs = require('fs');

const { request, gql } = require('graphql-request');

const endpoint = process.env.PERSONAL_TOKEN
  ? `${process.env.API_URL}/graphql?personalToken=${process.env.PERSONAL_TOKEN}`
  : `${process.env.API_URL}/graphql/${process.env.API_KEY}`;

const statsFragment = gql`
  fragment StatsFragment on Account {
    id
    slug
    stats {
      id
      balance(dateTo: $toDate) {
        amount
        currency
      }
      balanceWithBlockedFunds: balance(dateTo: $toDate, withBlockedFunds: true) {
        amount
        currency
      }
      totalAmountSpent(dateTo: $toDate) {
        amount
        currency
      }
      totalAmountSpentWithGiftCards: totalAmountSpent(dateTo: $toDate, includeGiftCards: true) {
        amount
        currency
      }
      totalAmountReceived(dateTo: $toDate) {
        amount
        currency
      }
      netTotalAmountReceived: netTotalAmountReceived(dateTo: $toDate, net: true) {
        amount
        currency
      }
      totalAmountReceivedWithChildren: totalAmountReceived(dateTo: $toDate, includeChildren: true) {
        amount
        currency
      }
      totalPaidExpenses(dateTo: $toDate) {
        amount
        currency
      }
      contributionsAmount(dateTo: $toDate) {
        amount
        currency
      }
      contributionsAmountWithChildren: contributionsAmount(dateTo: $toDate, includeChildren: true) {
        amount
        currency
      }
    }
  }
`;

const query = gql`
  query LedgerStats($toDate: DateTime) {
    opensource: account(slug: "opensource") {
      ...StatsFragment
    }
    opencollective: account(slug: "opencollective") {
      ...StatsFragment
    }
    foundation: account(slug: "foundation") {
      ...StatsFragment
    }
    babel: account(slug: "babel") {
      ...StatsFragment
    }
    webpack: account(slug: "webpack") {
      ...StatsFragment
    }
    captainfact: account(slug: "captainfact_io") {
      ...StatsFragment
    }
    manjaro: account(slug: "manjaro") {
      ...StatsFragment
    }
    agileLeanEurope: account(slug: "agile-lean-europe") {
      ...StatsFragment
    }
  }
  ${statsFragment}
`;

const getProgram = (argv) => {
  const program = new Command();
  program.exitOverride();
  program.showSuggestionAfterError();
  program.parse(argv);
  return program;
};

async function main(argv = process.argv) {
  const program = getProgram(argv);
  const options = program.opts();
  const [slug, exportDir] = program.args;
  const limit = options.limit ? parseInt(options.limit) : 500;
  let types;

  if (!options.run) {
    console.log(`This is a dry run, run the script with --run to trigger it for real.`);
  }

  if (options.types) {
    types = options.types.split(',');
  }

  const result = await request(endpoint, query, { slug, types, limit });

  // Generate a CSV file from the result
  const csv = [];
  for (const key in result) {
    const account = result[key];
    const stats = account.stats;
    const formatAmount = (amount) => (amount ? `${amount.amount} ${amount.currency}` : '');
    const row = {
      slug: account.slug,
      balance: stats.balance.amount,
      balanceWithBlockedFunds: stats.balanceWithBlockedFunds.amount,
      totalAmountSpent: stats.totalAmountSpent.amount,
      totalAmountSpentWithGiftCards: stats.totalAmountSpentWithGiftCards.amount,
      totalAmountReceived: stats.totalAmountReceived.amount,
      netTotalAmountReceived: stats.netTotalAmountReceived.amount,
      totalAmountReceivedWithChildren: stats.totalAmountReceivedWithChildren.amount,
      totalPaidExpenses: stats.totalPaidExpenses.amount,
      contributionsAmount: stats.contributionsAmount.amount,
      contributionsAmountWithChildren: stats.contributionsAmountWithChildren.amount,
    };
    csv.push(row);
  }

  const headers = Object.keys(csv[0]).join(',');
  const rows = csv.map((row) => Object.values(row).join(',')).join('\n');
  const content = `${headers}\n${rows}`;

  if (exportDir) {
    const filename = `${exportDir}/${slug}-stats.csv`;
  }
}

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
