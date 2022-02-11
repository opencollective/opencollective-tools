require('../env');

const fs = require('fs');

const { Command } = require('commander');
const csvParseSync = require('csv-parse/sync'); // eslint-disable-line node/no-missing-require

const { request, gql } = require('graphql-request');

const mapping = require('./csv-import-mapping.json');

const endpoint = `${process.env.API_URL}/graphql/v2/${process.env.API_KEY}`;

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
      }
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

const catchException = () => {
  return null;
};

async function fetchCollectiveWithGithubHandle(githubHandle) {
  const dataWithGithubHandle = await request(endpoint, collectiveQuery, { githubHandle }).catch(catchException);
  if (dataWithGithubHandle && dataWithGithubHandle.collective.host?.slug === 'opensource') {
    return dataWithGithubHandle.collective;
  }
}

async function fetchCollectiveWithSlug(slug) {
  const dataWithSlug = await request(endpoint, collectiveQuery, { slug }).catch(catchException);
  if (dataWithSlug && dataWithSlug.collective.host?.slug === 'opensource') {
    return dataWithSlug.collective;
  }
}

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
    const amount = parseFloat(record['processed amount'].replace('$', '').replace(',', ''));

    let collective;

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
    if (!collective) {
      console.warn(`Error finding a matching Collective for GitHub Organization ${organization}`);
      continue;
    }

    const variables = {
      fromAccount: { slug: 'github-sponsors' },
      account: { slug: collective.slug },
      amount: { value: amount, currency: 'USD' },
      description: 'GitHub Sponsors payment',
      hostFeePercent: 10,
    };

    console.log(`Adding $${amount} to ${collective.slug} ${!options.run ? '(dry run)' : ''}`);

    // Poor man rate-limiting (100 req / minute max on the API)
    await sleep(600);

    if (options.run) {
      const result = await request(endpoint, addFundsMutation, variables);
      console.log(result);
      await sleep(600);
    }
  }
}

const getProgram = (argv) => {
  const program = new Command();
  program.exitOverride();
  program.showSuggestionAfterError();

  program.argument('<string>', 'Path to the CSV file to parse.');

  program.option('--run', 'Trigger import.');

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
