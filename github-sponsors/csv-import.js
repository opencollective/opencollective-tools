require('../env');

const fs = require('fs');

const { Command } = require('commander');
const csvParseSync = require('csv-parse/sync'); // eslint-disable-line node/no-missing-require

const { request, gql } = require('graphql-request');

const mapping = require('./csv-import-mapping.json');

const endpoint = process.env.PERSONAL_TOKEN
  ? `${process.env.API_URL}/graphql?personalToken=${process.env.PERSONAL_TOKEN}`
  : `${process.env.API_URL}/graphql/${process.env.API_KEY}`;

const supportedHosts = ['opensource', 'europe'];

const collectiveQuery = gql`
  query Collective($slug: String, $githubHandle: String) {
    collective(githubHandle: $githubHandle, slug: $slug) {
      id
      type
      slug
      name
      host {
        id
        slug
        currency
      }
      currency
      addedFundsHostFeePercent: hostFeePercent(paymentMethodType: HOST)
    }
  }
`;

const addFundsMutation = gql`
  mutation AddFunds(
    $fromAccount: AccountReferenceInput!
    $account: AccountReferenceInput!
    $amount: AmountInput!
    $description: String!
    $hostFeePercent: Float!
  ) {
    addFunds(
      account: $account
      fromAccount: $fromAccount
      amount: $amount
      description: $description
      hostFeePercent: $hostFeePercent
    ) {
      id
    }
  }
`;

const sleep = (ms) => {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
};

const parseAmount = (string) => {
  return parseFloat(string.replace('$', '').replace('€', '').replace(',', ''));
};

async function fetchCollectiveWithGithubHandle(githubHandle) {
  const dataWithGithubHandle = await request(endpoint, collectiveQuery, { githubHandle });
  const hostSlug = dataWithGithubHandle?.collective.host?.slug;
  if (dataWithGithubHandle && supportedHosts.includes(hostSlug)) {
    return dataWithGithubHandle.collective;
  }
}

async function fetchCollectiveWithSlug(slug) {
  const dataWithSlug = await request(endpoint, collectiveQuery, { slug });
  const hostSlug = dataWithSlug?.collective.host?.slug;
  if (dataWithSlug && supportedHosts.includes(hostSlug)) {
    return dataWithSlug.collective;
  }
}

/*
async function getFxRate(from, to, date = 'latest') {
  const params = {
    access_key: process.env.FIXER_ACCESS_KEY, // eslint-disable-line camelcase
    base: from,
    symbols: to,
  };

  const result = await fetch(`https://data.fixer.io/${date}?${new URLSearchParams(params)}`).then((res) => res.json());

  return result?.rates?.[to];
}

const fxRates = new Map();

async function getAmountInCurrency(amount, currency, date) {
  if (amount.currency === currency) {
    return amount;
  }

  if (!fxRates[amount.currency]) {
    fxRates[amount.currency] = new Map();
  }
  if (!fxRates[amount.currency][currency]) {
    fxRates[amount.currency][currency] = new Map();
  }

  let fxRate = fxRates[amount.currency][currency][date];
  if (!fxRate) {
    const fixerFxRate = await getFxRate(amount.currency, currency, date);
    if (!fixerFxRate) {
      throw new Error('Could not fetch fxRate from fixer');
    }
    console.log(`Using ${fixerFxRate} as ${amount.currency} -> ${currency} fxRate on ${date}`);
    fxRate = fxRates[amount.currency][currency][date] = fixerFxRate;
  }

  return { value: parseFloat(amount.value * fxRate).toFixed(2), currency };
}
*/

async function main(argv = process.argv) {
  const program = getProgram(argv);
  const options = program.opts();
  const [inputFilename] = program.args;

  if (!options.run) {
    console.log(`This is a dry run, run the script with --run to trigger it for real.`);
  }

  const input = fs.readFileSync(inputFilename, 'utf8');

  const records = csvParseSync.parse(input, { columns: true });

  for (const record of records) {
    const organization = record['organization'];

    let collective;

    try {
      if (mapping[organization]) {
        collective = await fetchCollectiveWithSlug(mapping[organization]);
      }
      if (!collective) {
        collective = await fetchCollectiveWithGithubHandle(organization);
        if (collective) {
          console.warn(`Detected a new Collective through githubHandle "${organization}": "${collective.slug}"`);
        }
      }
      if (!collective) {
        collective = await fetchCollectiveWithSlug(organization);
        if (collective) {
          console.warn(`Detected a new Collective through slug "${organization}": "${collective.slug}"`);
        }
      }
    } catch (err) {
      if (err.response?.error?.message) {
        console.warn(`Error with Open Collective API request. ${err.response?.error?.message}`);
      } else {
        console.log(err);
      }
      continue;
    }

    if (!collective) {
      console.warn(`Error finding a matching Collective for GitHub Organization ${organization}`);
      continue;
    }

    if (collective.host.currency !== collective.currency) {
      console.warn(`Currency mismatch for ${organization} (${collective.host.currency} !== ${collective.currency})`);
      continue;
    }

    const amount = { value: parseAmount(record['amount']), currency: collective.host.currency };

    /*
    let amount;
    if (collective.host.currency === 'USD') {
      const processedAmountKey = Object.keys(record).find((key) => key.match(/processed amount/i));
      const processedAmountValue = parseFloat(record[processedAmountKey].replace('$', '').replace(',', ''));
      amount = { value: processedAmountValue, currency: 'USD' };
    } else {
      amount = { value: record['amount'], currency: collective.host.currency };
    }
    amount = await getAmountInCurrency(amount, collective.currency, record['payout date']);
    */

    const variables = {
      fromAccount: { slug: 'github-sponsors' },
      account: { slug: collective.slug },
      amount: amount,
      description: options.description,
      hostFeePercent: collective.addedFundsHostFeePercent,
    };

    console.log(
      `Adding ${amount.value} ${amount.currency} to https://opencollective.com/${collective.slug} with ${
        collective.addedFundsHostFeePercent
      }% host fee and description "${options.description}" ${!options.run ? '(dry run)' : ''}`,
    );

    // Poor man rate-limiting (100 req / minute max on the API)
    await sleep(1000);

    if (options.run) {
      const result = await request(endpoint, addFundsMutation, variables);
      console.log(result);
      await sleep(1000);
    }
  }
}

const getProgram = (argv) => {
  const program = new Command();
  program.exitOverride();
  program.showSuggestionAfterError();

  program.argument('<string>', 'Path to the CSV file to parse.');

  program.option('--run', 'Trigger import.');

  program.option('--description <description>', 'The description for the payment', 'GitHub Sponsors Contributions');

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
