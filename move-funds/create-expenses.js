require('../env');

const fs = require('fs');
const prompt = require('prompt');

const { Command } = require('commander');
const csvParseSync = require('csv-parse/sync'); // eslint-disable-line node/no-missing-require

const { gql } = require('graphql-request');
const {
  addSharedOptionsToProgram,
  get2FAHeadersFromPrompt,
  rateLimitedRequest,
  parseBalanceToCents,
  extractSlugFromUrl,
} = require('./lib');

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

const processExpenseMutation = gql`
  mutation ProcessExpense($expenseId: String!, $action: ExpenseProcessAction!) {
    processExpense(expense: { id: $expenseId }, action: $action) {
      id
      status
    }
  }
`;

async function main(argv = process.argv) {
  const program = getProgram(argv);
  const options = program.opts();
  const [inputFilename] = program.args;

  prompt.start();

  if (!options.run) {
    console.log(`This is a dry run, run the script with --run to trigger it for real.`);
  }

  const input = fs.readFileSync(inputFilename, 'utf8');
  const records = csvParseSync.parse(input, { columns: true });

  const createdExpenses = [];
  let skippedCount = 0;

  for (const record of records) {
    const sourceUrl = record['Open Collective'];
    const destinationUrl = record['fund url'];
    const balance = record['Balance'];
    const collectiveName = record['Collective'];

    const sourceSlug = extractSlugFromUrl(sourceUrl);
    const destinationSlug = extractSlugFromUrl(destinationUrl);
    const amountCents = parseBalanceToCents(balance);

    // Skip rows without valid source, destination, or amount
    if (!sourceSlug || !destinationSlug || amountCents <= 0) {
      console.log(`Skipping: ${collectiveName || sourceUrl} - missing source, destination, or zero balance`);
      skippedCount++;
      continue;
    }

    const variables = {
      account: { slug: sourceSlug },
      expense: {
        type: 'INVOICE',
        payee: { slug: destinationSlug },
        currency: 'USD',
        items: [
          {
            description: `Balance transfer from ${collectiveName || sourceSlug}`,
            amount: amountCents,
          },
        ],
        description: `Balance transfer from ${collectiveName || sourceSlug} to ${destinationSlug}`,
        payoutMethod: {
          type: 'ACCOUNT_BALANCE',
          data: {},
        },
      },
    };

    console.log(
      `Creating Expense: ${balance} from ${sourceSlug} to ${destinationSlug} ${!options.run ? '(dry run)' : ''}`,
    );

    if (options.run) {
      try {
        const result = await rateLimitedRequest(endpoint, createExpenseMutation, variables);
        const expenseId = result.createExpense.id;
        const legacyId = result.createExpense.legacyId;

        console.log(`Created: https://opencollective.com/${sourceSlug}/expenses/${legacyId}`);

        // Approve the expense
        try {
          await rateLimitedRequest(endpoint, processExpenseMutation, { expenseId, action: 'APPROVE' });
          console.log(`Approved!`);
        } catch (e) {
          if (e.message.includes('Two-factor authentication')) {
            const headers = await get2FAHeadersFromPrompt(options);
            await rateLimitedRequest(endpoint, processExpenseMutation, { expenseId, action: 'APPROVE' }, headers);
            console.log(`Approved!`);
          } else {
            console.log(`Failed to approve: ${e.message}`);
          }
        }

        createdExpenses.push({
          sourceSlug,
          destinationSlug,
          amount: balance,
          expenseId,
          legacyId,
        });
      } catch (e) {
        console.log(`Failed to create expense: ${e.message}`);
        continue;
      }
    }
  }

  console.log(`\nSummary:`);
  console.log(`- Created and approved: ${createdExpenses.length}`);
  console.log(`- Skipped: ${skippedCount}`);

  if (options.run && createdExpenses.length > 0) {
    const outputFile = inputFilename.replace('.csv', '-expenses.json');
    fs.writeFileSync(outputFile, JSON.stringify(createdExpenses, null, 2));
    console.log(`\nExpense IDs saved to: ${outputFile}`);
    console.log(`Run pay-expenses.js with this file to pay the expenses.`);
  }
}

const getProgram = (argv) => {
  const program = new Command();
  program.exitOverride();
  program.showSuggestionAfterError();

  program.argument('<csvPath>', 'Path to the CSV file to parse.');

  addSharedOptionsToProgram(program);

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
