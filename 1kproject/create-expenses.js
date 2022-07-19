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
        legacyId
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
      legacyId
    }
  }
`;

const processExpenseMutation = gql`
  mutation ProcessExpense($expenseId: String!, $action: ExpenseProcessAction!) {
    processExpense(expense: { id: $expenseId }, action: $action) {
      id
      status
    }
  }
`;

// https://en.wikipedia.org/wiki/Postal_codes_in_Ukraine
const SANCTIONED_REGIONS_POSTAL_CODE_PREFIX = [95, 96, 97, 98, 91, 92, 93, 94, 83, 84, 85, 86, 87];

const tokenizeCard = (cardNumber) =>
  axios.post(`${WISE_API_URL}/v3/card`, { cardNumber }).then((response) => response?.data?.cardToken);

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
    const email = 'donors@1kproject.org';
    const postCode = record['POST CODE'];
    const address = record['ADDRESS'];
    const city = record['CITY'];
    const bankCard = record['BANK CARD'];
    const name = replace(replace(deburr(record['NAME']), /['`ʹ‘]/gm, ''), /\s+/gm, ' ');

    if (SANCTIONED_REGIONS_POSTAL_CODE_PREFIX.some((zip) => startsWith(postCode, toString(zip)))) {
      console.log(`Warning! Potential sanctioned zipcode for ${name} ${email}: ${postCode} ${city}`);
    }

    const match = allExpenses.find((expense) => JSON.stringify(expense).includes(name));
    if (match) {
      // console.log(`Skipping for ${name} ${!options.run ? '(dry run)' : ''}`);
      console.log(`Warning! Existing expense: https://opencollective.com/1kproject/expenses/${match.legacyId}`);
    }

    let cardToken = 'fake-token';
    if (options.run) {
      try {
        // console.log(`Tokenizing ${bankCard}`);
        cardToken = await tokenizeCard(bankCard);
      } catch (e) {
        console.log(e);
        await sleep(2000);
        if (e.response.status === 429) {
          console.log('Wise API rate limit, retrying in 5 seconds.');
          await sleep(5000);
          cardToken = await tokenizeCard(bankCard);
        } else {
          console.log(`Error Tokenizing for ${email} ${bankCard}: ${e.response.statusText}. Skipping.`);
          // console.log(e);
          continue;
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

      try {
        const result = await request(endpoint, createExpenseMutation, variables);
        console.log(`Success! https://opencollective.com/1kproject/expenses/${result.createExpense.legacyId}`);
        await request(endpoint, processExpenseMutation, { expenseId: result.createExpense.id, action: 'APPROVE' });
      } catch (e) {
        console.log(e);
        continue;
      }

      // Slow down for both Open Collective and Wise API Limits
      // (100 req / minute max on Open Collective API)
      await sleep(12000);
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
