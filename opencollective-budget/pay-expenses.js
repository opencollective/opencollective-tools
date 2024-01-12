require('../env');

const prompt = require('prompt');

const { Command } = require('commander');

const { request, gql } = require('graphql-request');

const endpoint = process.env.PERSONAL_TOKEN
  ? `${process.env.API_URL}/graphql?personalToken=${process.env.PERSONAL_TOKEN}`
  : `${process.env.API_URL}/graphql/${process.env.API_KEY}`;

const expensesQuery = gql`
  query {
    expenses(
      account: { slug: "opencollective" }
      limit: 1000
      status: APPROVED
      orderBy: { field: CREATED_AT, direction: ASC }
      searchTerm: "Adjustment for off-platform expense activity"
    ) {
      totalCount
      nodes {
        id
        createdAt
        description
        status
        amount
        payee {
          id
          slug
        }
        payoutMethod {
          id
          type
          name
          data
        }
      }
    }
  }
`;

const payExpenseMutation = gql`
  mutation PayExpense($expense: ExpenseReferenceInput!) {
    processExpense(expense: $expense, action: PAY) {
      id
    }
  }
`;

const sleep = (ms) => {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
};

async function main(argv = process.argv) {
  const program = getProgram(argv);
  const options = program.opts();

  prompt.start();

  if (!options.run) {
    console.log(`This is a dry run, run the script with --run to trigger it for real.`);
  }

  const expenses = await request(endpoint, expensesQuery).then((result) => result.expenses.nodes);

  console.log(`Found ${expenses.length} APPROVED expenses.`);

  for (const expense of expenses) {
    const variables = {
      expense: {
        id: expense.id,
      },
    };

    console.log(`Paying Expense "${expense.description}" ${!options.run ? '(dry run)' : ''}`);

    if (options.run) {
      const result = await request(endpoint, payExpenseMutation, variables);

      console.log(result);

      // Poor man rate-limiting (100 req / minute max on the API)
      await sleep(1000);
    }
  }
}

const getProgram = (argv) => {
  const program = new Command();
  program.exitOverride();
  program.showSuggestionAfterError();

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
