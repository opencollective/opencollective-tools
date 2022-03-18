require('../env');

const fs = require('fs');
const axios = require('axios').default;
const { deburr, replace, startsWith, toString } = require('lodash');

const { Command } = require('commander');
const csvParseSync = require('csv-parse/sync'); // eslint-disable-line node/no-missing-require

const { request, gql } = require('graphql-request');

const endpoint = `${process.env.API_URL}/graphql/v2/${process.env.API_KEY}`;
const WISE_API_URL = process.env.TRANSFERWISE_API_URL || 'https://api.transferwise.com';

const expensesQuery = gql`
  query {
    expenses(account: { slug: "1kproject" }, limit: 1000) {
      totalCount
      nodes {
        id
        createdAt
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

const createExpenseMutation = gql`
  mutation CreateExpense($expense: ExpenseCreateInput!, $account: AccountReferenceInput!) {
    createExpense(expense: $expense, account: $account) {
      id
    }
  }
`;

const processExpenseMutation = gql/* GraphQL */ `
  mutation ProcessExpense($expenseId: String!, $action: ExpenseProcessAction!) {
    processExpense(expense: { id: $expenseId }, action: $action) {
      id
      status
    }
  }
`;

const tokenizeCard = (cardNumber) =>
  axios.post(`${WISE_API_URL}/v3/card`, { cardNumber }).then((response) => response?.data?.cardToken);

const sleep = (ms) => {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
};

// https://en.wikipedia.org/wiki/Postal_codes_in_Ukraine
const SANCTIONED_REGIONS_POSTAL_CODE_PREFIX = [95, 96, 97, 98, 91, 92, 93, 94, 83, 84, 85, 86, 87];

const catchException = (e) => {
  console.log(e);
  return null;
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

  const allExpenses = await request(endpoint, expensesQuery)
    .catch(catchException)
    .then((result) => result.expenses.nodes);

  for (const record of records) {
    const email = record['EMAIL'];
    const postCode = record['POST CODE'];
    const address = record['ADDRESS'];
    const city = record['CITY'];
    const bankCard = record['BANK CARD'];
    const name = replace(replace(deburr(record['NAME']), /['`ʹ]/gm, ''), /\s+/gm, ' ');

    if (SANCTIONED_REGIONS_POSTAL_CODE_PREFIX.some((zip) => startsWith(postCode, toString(zip)))) {
      console.log(`Skipping ${name} ${email}: sanctioned zipcode ${postCode}, ${address}`);
      continue;
    }

    const match = allExpenses.map((expense) => JSON.stringify(expense)).some((string) => string.includes(email));
    if (match) {
      console.log(`Skipping for ${email} ${!options.run ? '(dry run)' : ''}`);
      continue;
    }

    let cardToken = 'fake-token';
    if (options.run) {
      try {
        cardToken = await tokenizeCard(bankCard);
      } catch (e) {
        if (e.response.status === 429) {
          console.log('Wise API rate limit, waiting and retrying');
          await sleep(10000);
          cardToken = await tokenizeCard(bankCard);
        } else {
          throw e.response?.data || e;
        }
      }
    }

    const variables = {
      account: { slug: '1kproject' },
      expense: {
        type: 'INVOICE',
        payee: { slug: 'ukrainian-families-1k' },
        currency: 'USD',
        items: [
          {
            description: `${name} Family`,
            amount: 100000,
          },
        ],
        description: `${name} Family`,
        payoutMethod: {
          type: 'BANK_ACCOUNT',
          data: {
            type: 'CARD',
            details: {
              email: email,
              address: {
                city: city,
                country: 'UA',
                postCode: postCode,
                firstLine: address,
              },
              cardToken,
              legalType: 'PRIVATE',
            },
            currency: 'UAH',
            accountHolderName: name,
          },
        },
      },
    };

    console.log(`Creating Expense ${variables.expense.description} ${!options.run ? '(dry run)' : ''}`);

    if (options.run) {
      if (cardToken === 'fake-token' || !cardToken) {
        throw new Error('Test card passed to run, aborting...');
      }
      const result = await request(endpoint, createExpenseMutation, variables);
      console.log(result);

      const expenseId = result.createExpense.id;
      await request(endpoint, processExpenseMutation, { expenseId: expenseId, action: 'APPROVE' });

      // Increased Sleep time due to Tokenize Card API rate limit
      await sleep(7000);
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
