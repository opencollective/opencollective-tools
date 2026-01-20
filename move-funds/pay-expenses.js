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
  mutation PayExpense($expense: ExpenseReferenceInput!, $paymentParams: ProcessExpensePaymentParams!) {
    processExpense(expense: $expense, action: PAY, paymentParams: $paymentParams) {
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
  const expenses = JSON.parse(input);

  console.log(`Found ${expenses.length} expenses to pay.`);

  let paidCount = 0;
  let failedCount = 0;

  for (const expense of expenses) {
    const { sourceSlug, destinationSlug, amount, expenseId } = expense;

    console.log(
      `Paying Expense: ${amount} from ${sourceSlug} to ${destinationSlug} ${!options.run ? '(dry run)' : ''}`,
    );

    if (options.run) {
      const variables = {
        expense: { id: expenseId },
        paymentParams: {
          forceManual: true, // For ACCOUNT_BALANCE transfers
        },
      };

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
      } catch (e) {
        console.log(`Failed to pay: ${e.message}`);
        failedCount++;
        continue;
      }
    }
  }

  console.log(`\nSummary:`);
  console.log(`- Paid: ${paidCount}`);
  console.log(`- Failed: ${failedCount}`);
}

const getProgram = (argv) => {
  const program = new Command();
  program.exitOverride();
  program.showSuggestionAfterError();

  program.argument('<jsonPath>', 'Path to the JSON file created by create-expenses.js');

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
