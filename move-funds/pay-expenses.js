require('../env');

const fs = require('fs');
const prompt = require('prompt');

const { Command } = require('commander');

const { gql } = require('graphql-request');
const { addSharedOptionsToProgram, get2FAHeadersFromPrompt, rateLimitedRequest } = require('./lib');

const endpoint = process.env.PERSONAL_TOKEN
  ? `${process.env.API_URL}/graphql?personalToken=${process.env.PERSONAL_TOKEN}`
  : `${process.env.API_URL}/graphql/${process.env.API_KEY}`;

const payExpenseMutation = gql`
  mutation PayExpense($expense: ExpenseReferenceInput!) {
    processExpense(expense: $expense, action: PAY) {
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

  // Read the JSON file created by create-expenses.js
  const input = fs.readFileSync(inputFilename, 'utf8');
  let expenses = JSON.parse(input);
  const originalCount = expenses.length;

  console.log(`Found ${expenses.length} expenses to pay.`);

  let paidCount = 0;
  let failedCount = 0;

  for (let i = 0; i < originalCount; i++) {
    if (options.limit && i >= options.limit) {
      console.log(`\nReached limit of ${options.limit} expenses, stopping.`);
      break;
    }

    const expense = expenses[0]; // Always take first (we remove on success)
    if (!expense) break;

    const { sourceSlug, destinationSlug, amount, expenseId } = expense;

    const variables = {
      expense: { id: expenseId },
    };

    console.log(
      `Paying Expense: ${amount} from ${sourceSlug} to ${destinationSlug} ${!options.run ? '(dry run)' : ''}`,
    );
    console.log('Variables:', JSON.stringify(variables, null, 2));

    if (options.run) {
      try {
        let result;
        try {
          result = await rateLimitedRequest(endpoint, payExpenseMutation, variables);
        } catch (e) {
          if (e.message.includes('Two-factor authentication')) {
            const headers = await get2FAHeadersFromPrompt(options);
            result = await rateLimitedRequest(endpoint, payExpenseMutation, variables, headers);
          } else {
            throw e;
          }
        }

        console.log(`Paid! Status: ${result.processExpense.status}`);
        paidCount++;

        // Remove paid expense and flush to file
        expenses = expenses.slice(1);
        fs.writeFileSync(inputFilename, JSON.stringify(expenses, null, 2));
      } catch (e) {
        console.log(`Failed to pay: ${e.message}`);
        failedCount++;
        // Stop on failure - expense stays in file for retry
        break;
      }
    }
  }

  console.log(`\nSummary:`);
  console.log(`- Paid: ${paidCount}`);
  console.log(`- Failed: ${failedCount}`);
  if (options.run) {
    console.log(`- Remaining in file: ${expenses.length}`);
  }
}

const getProgram = (argv) => {
  const program = new Command();
  program.exitOverride();
  program.showSuggestionAfterError();

  program.argument('<jsonPath>', 'Path to the JSON file created by create-expenses.js');

  addSharedOptionsToProgram(program);
  program.option('--limit <number>', 'Limit the number of expenses to pay', parseInt);

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
