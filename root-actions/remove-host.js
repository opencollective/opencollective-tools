require('../env');

const { Command } = require('commander');

const { request, gql } = require('graphql-request');

const endpoint = `${process.env.API_URL}/graphql/v2/${process.env.API_KEY}`;

const accountQuery = gql`
  query Account($slug: String) {
    account(slug: $slug) {
      id
      type
      slug
      ... on AccountWithHost {
        host {
          id
        }
      }
    }
  }
`;

const removeHostMutation = gql`
  mutation RemoveHost($id: String!) {
    removeHost(account: { id: $id }) {
      id
      ... on AccountWithHost {
        host {
          id
        }
      }
    }
  }
`;

// const sleep = (ms) => {
//   return new Promise((resolve) => {
//     setTimeout(resolve, ms);
//   });
// };

const catchException = (e) => {
  console.log(e);
  return null;
};

async function fetchAccountWithSlug(slug) {
  const data = await request(endpoint, accountQuery, { slug }).catch(catchException);
  return data?.account;
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
    console.warn(`Error finding an account with slug "${slug}"${!options.run ? ' (dry run)' : ''}`);
    return;
  }
  if (!account.host) {
    console.warn(`Warning: No Host for the account with slug "${account.slug}"${!options.run ? ' (dry run)' : ''}`);
    return;
  }

  console.warn(`Removing Host for account with slug "${account.slug}"${!options.run ? ' (dry run)' : ''}`);

  if (options.run) {
    const result = await request(endpoint, removeHostMutation, { id: account.id });
    console.log(result);
  }
}

const getProgram = (argv) => {
  const program = new Command();
  program.exitOverride();
  program.showSuggestionAfterError();

  program.argument('<string>', 'The slug of the Account to Unhost');

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
