require('../env');

const fs = require('fs');

const { Command } = require('commander');
const csvParseSync = require('csv-parse/sync'); // eslint-disable-line node/no-missing-require

const { request, gql } = require('graphql-request');

const endpoint = process.env.PERSONAL_TOKEN
  ? `${process.env.API_URL}/graphql?personalToken=${process.env.PERSONAL_TOKEN}`
  : `${process.env.API_URL}/graphql/${process.env.API_KEY}`;

const createExpenseMutation = gql`
  mutation CreateExpense($expense: ExpenseCreateInput!, $account: AccountReferenceInput!) {
    createExpense(expense: $expense, account: $account) {
      id
      legacyId
    }
  }
`;

/*
const processExpenseMutation = gql`
  mutation ProcessExpense($expenseId: String!, $action: ExpenseProcessAction!) {
    processExpense(expense: { id: $expenseId }, action: $action) {
      id
      status
    }
  }
`;
*/

const sleep = (ms) => {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
};

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
    console.log(record);

    const variables = {
      account: { slug: 'opencollective' },
      expense: {
        type: 'INVOICE',
        payee: { slug: 'opencollective' },
        currency: 'USD',
        items: [
          {
            description: record['Expense description'],
            amountV2: {
              value: Number(record['Amount'].replace(/[,()$\s]/g, '')),
              currency: 'USD',
            },
            incurredAt: new Date(record['Date']),
          },
        ],
        description: record['Expense title'],
        payoutMethod: {
          type: 'ACCOUNT_BALANCE',
          // Why? TODO: for developer experience
          data: {},
        },
      },
    };

    console.log(`Creating Expense ${variables.expense.description}${!options.run ? ' (dry run)' : ''}`);

    if (options.run) {
      try {
        const result = await request(endpoint, createExpenseMutation, variables);
        console.log(`Success! https://opencollective.com/opencollective/expenses/${result.createExpense.legacyId}`);
        // await request(endpoint, processExpenseMutation, { expenseId: result.createExpense.id, action: 'APPROVE' });
      } catch (e) {
        console.log(e);
        continue;
      }

      // Slow down
      // (100 req / minute max on Open Collective API)
      await sleep(1000);
    }
  }
}

const getProgram = (argv) => {
  const program = new Command();
  program.exitOverride();
  program.showSuggestionAfterError();

  program.argument('<csvPath>', 'Path to the CSV file to parse.');

  program.option('--run', 'Disables the dry mode.');

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
