require('../env');

const prompt = require('prompt');

const { Command } = require('commander');

const { request, gql } = require('graphql-request');

const endpoint = `${process.env.API_URL}/graphql/v2/${process.env.API_KEY}`;

const expensesQuery = gql`
  query {
    expenses(
      account: { slug: "1kproject" }
      limit: 1000
      status: APPROVED
      orderBy: { field: CREATED_AT, direction: ASC }
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
  mutation PayExpense($expense: ExpenseReferenceInput!, $paymentParams: ProcessExpensePaymentParams!) {
    processExpense(expense: $expense, action: PAY, paymentParams: $paymentParams) {
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

  let tfaPrompt;
  prompt.start();

  if (!options.run) {
    console.log(`This is a dry run, run the script with --run to trigger it for real.`);
  }

  const expenses = await request(endpoint, expensesQuery).then((result) => result.expenses.nodes);

  console.log(`Found ${expenses.length} APPROVED expenses.`);

  for (const expense of expenses) {
    if (expense.payoutMethod?.type !== 'BANK_ACCOUNT' || !expense.payoutMethod?.data?.details?.cardToken) {
      console.log(
        `Unable to Pay Expense "${expense.description}", missing structured information ${
          !options.run ? '(dry run)' : ''
        }`,
      );
      continue;
    }

    const variables = {
      expense: {
        id: expense.id,
      },
      paymentParams: {
        feesPayer: 'PAYEE',
      },
    };

    console.log(`Paying Expense "${expense.description}" ${!options.run ? '(dry run)' : ''}`);

    if (options.run) {
      // Poor man rate-limiting (100 req / minute max on the API)
      await sleep(10000);

      let result;
      try {
        result = await request(endpoint, payExpenseMutation, variables);
      } catch (e) {
        if (e.message.includes('Two-factor authentication')) {
          tfaPrompt = await prompt.get({ name: 'tfa', description: '2FA Code' });
          result = await request(endpoint, payExpenseMutation, variables, {
            'x-two-factor-authentication': `totp ${tfaPrompt.tfa}`,
          });
        } else {
          throw e;
        }
        tfaPrompt = null;
      }

      console.log(result);
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
