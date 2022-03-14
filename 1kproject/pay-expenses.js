require('../env');

const prompt = require('prompt');

const { Command } = require('commander');

const { request, gql } = require('graphql-request');

const endpoint = `${process.env.API_URL}/graphql/v2/${process.env.API_KEY}`;

const expensesQuery = gql`
  query {
    expenses(account: { slug: "1kproject" }, limit: 100, status: APPROVED) {
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

const catchException = (e) => {
  console.log(e);
  return null;
};

async function main(argv = process.argv) {
  const program = getProgram(argv);
  const options = program.opts();

  let twoFactorAuthenticatorCode;

  if (!options.run) {
    console.log(`This is a dry run, run the script with --run to trigger it for real.`);
  }

  const expenses = await request(endpoint, expensesQuery)
    .catch(catchException)
    .then((result) => result.expenses.nodes);

  for (const expense of expenses) {
    if (!expense.type !== 'BANK_ACCOUNT' || !expense.data.accoutNumber) {
      console.log(
        `Unable to Pay Expense "${expense.description}", missing structured information ${
          !options.run ? '(dry run)' : ''
        }`,
      );
      continue;
    }

    if (!twoFactorAuthenticatorCode) {
      prompt.start();
      twoFactorAuthenticatorCode = await prompt.get('2FA code');
    }

    const variables = {
      expense: {
        id: expense.id,
      },
      paymentParams: {
        twoFactorAuthenticatorCode,
      },
    };

    console.log(`Paying Expense "${expense.description}" ${!options.run ? '(dry run)' : ''}`);

    // Poor man rate-limiting (100 req / minute max on the API)
    await sleep(600);

    if (options.run) {
      const result = await request(endpoint, payExpenseMutation, variables);
      console.log(result);
      await sleep(600);
    }
  }
}

const getProgram = (argv) => {
  const program = new Command();
  program.exitOverride();
  program.showSuggestionAfterError();

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
