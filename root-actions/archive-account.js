require('../env');

const { Command } = require('commander');

const { request, gql } = require('graphql-request');

const endpoint = `${process.env.API_URL}/graphql/v2/${process.env.API_KEY}`;

const endpointV1 = `${process.env.API_URL}/graphql/v1/${process.env.API_KEY}`;

const accountQuery = gql`
  query Account($slug: String) {
    account(slug: $slug) {
      id
      legacyId
      type
      slug
    }
  }
`;

const gqlV1 = gql;

const archiveCollectiveMutation = gqlV1`
  mutation ArchiveCollective($id: Int!) {
    archiveCollective(id: $id) {
      id
      isArchived
    }
  }
`;

const catchException = (e) => {
  console.log(e);
  return null;
};

async function fetchAccountWithSlug(slug) {
  const data = await request(endpoint, accountQuery, { slug }).catch(catchException);
  return data.account;
}

async function main(argv = process.argv) {
  const program = getProgram(argv);
  const options = program.opts();
  const [slug] = program.args;

  if (!options.run) {
    console.log(`This is a dry run, run the script with --run to trigger it for real.`);
  }

  const account = await fetchAccountWithSlug(slug);
  if (!account) {
    console.warn(`Error finding a matching Collective for GitHub Organization ${account}`);
    return;
  }

  console.warn(`Archiving Account with slug "${account.slug}"${!options.run ? ' (dry run)' : ''}`);

  if (options.run) {
    const result = await request(endpointV1, archiveCollectiveMutation, { id: account.legacyId });
    console.log(result);
  }
}

const getProgram = (argv) => {
  const program = new Command();
  program.exitOverride();
  program.showSuggestionAfterError();

  program.argument('<string>', 'The slug of the Account to Archive');

  program.option('--run', 'Trigger archive.');

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
